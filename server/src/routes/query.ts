import type { FastifyInstance } from 'fastify';
import type { Sort } from 'mongodb';
import { getClient, releaseClient } from '../db/connection.js';
import { DEFAULT_CHILD_LIMIT, DEFAULT_ROOT_LIMIT, MAX_ROOT_LIMIT, queryMasterDetail } from '../db/batcher.js';
import { parseBlueprint } from '../lib/config.js';
import {
  asRecord,
  badRequest,
  boundedInt,
  ejsonDocument,
  optionalString,
  requireString,
  toEjson,
} from '../lib/http.js';
import { dbFor, defaultDbFromUri, mongoUriFrom } from '../lib/mongoContext.js';
import { toMongoPath } from '../lib/paths.js';
import { isRequestReadOnly } from '../middleware/readOnly.js';

export async function queryRoutes(app: FastifyInstance): Promise<void> {
  /** Verify a connection profile; also reports what this user can see. */
  app.post('/api/connection/test', async (request) => {
    const uri = mongoUriFrom(request);
    const client = await getClient(uri);
    const admin = client.db('admin');
    const started = performance.now();
    await admin.command({ ping: 1 });
    const pingMs = Math.round(performance.now() - started);
    const build = (await admin.command({ buildInfo: 1 })) as { version?: string };
    let databases: string[] | undefined;
    try {
      const res = await admin.admin().listDatabases({ nameOnly: true, authorizedDatabases: true });
      databases = res.databases.map((d) => d.name).sort();
    } catch {
      databases = undefined; // restricted users may not list databases
    }
    return {
      ok: true,
      serverVersion: build.version ?? 'unknown',
      pingMs,
      defaultDb: defaultDbFromUri(uri) ?? null,
      databases: databases ?? null,
      readOnly: isRequestReadOnly(request),
    };
  });

  /** Close the cached client for this URI right away (instead of waiting for the TTL). */
  app.post('/api/connection/release', async (request) => {
    return { released: await releaseClient(mongoUriFrom(request)) };
  });

  app.get('/api/databases', async (request) => {
    const client = await getClient(mongoUriFrom(request));
    const res = await client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true });
    return { databases: res.databases.map((d) => d.name).sort() };
  });

  app.get<{ Params: { db: string } }>('/api/databases/:db/collections', async (request) => {
    const db = await dbFor(request, request.params.db);
    const cols = await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray();
    return {
      db: db.databaseName,
      collections: cols
        .map((c) => c.name)
        .filter((n) => !n.startsWith('system.'))
        .sort(),
    };
  });

  /** Plain find. Request filter/projection/sort are Extended JSON; documents return as canonical EJSON. */
  app.post('/api/query/find', async (request) => {
    const body = asRecord(request.body, 'body');
    const collection = requireString(body, 'collection');
    const filter = ejsonDocument(body, 'filter');
    const projection = ejsonDocument(body, 'projection');
    const sort = ejsonDocument(body, 'sort') as Sort;
    const skip = boundedInt(body, 'skip', { fallback: 0, min: 0, max: 1_000_000 });
    const limit = boundedInt(body, 'limit', { fallback: DEFAULT_ROOT_LIMIT, min: 1, max: MAX_ROOT_LIMIT });
    const db = await dbFor(request, optionalString(body, 'db'));

    const started = performance.now();
    let cursor = db.collection(collection).find(filter);
    if (Object.keys(projection).length > 0) cursor = cursor.project(projection);
    if (Object.keys(sort as object).length > 0) cursor = cursor.sort(sort);
    // Fetch limit + 1 to report hasMore without a count query.
    const docs = await cursor.skip(skip).limit(limit + 1).toArray();
    const hasMore = docs.length > limit;
    if (hasMore) docs.pop();
    return {
      db: db.databaseName,
      collection,
      documents: toEjson(docs),
      returned: docs.length,
      hasMore,
      ms: Math.round(performance.now() - started),
    };
  });

  /**
   * Schema sampling: the first N documents by _id, the last N by _id and N random
   * ones ($sample), de-duplicated. Gives a much better picture of a collection's
   * shape over time than "the first 200".
   */
  app.post('/api/query/sample', async (request) => {
    const body = asRecord(request.body, 'body');
    const collection = requireString(body, 'collection');
    const filter = ejsonDocument(body, 'filter');
    const first = boundedInt(body, 'first', { fallback: 10, min: 0, max: 500 });
    const last = boundedInt(body, 'last', { fallback: 10, min: 0, max: 500 });
    const random = boundedInt(body, 'random', { fallback: 10, min: 0, max: 500 });
    const db = await dbFor(request, optionalString(body, 'db'));
    const coll = db.collection(collection);
    const maxTimeMS = 15_000;

    const started = performance.now();
    const [head, tail, sampled] = await Promise.all([
      first > 0 ? coll.find(filter, { maxTimeMS }).sort({ _id: 1 }).limit(first).toArray() : [],
      last > 0 ? coll.find(filter, { maxTimeMS }).sort({ _id: -1 }).limit(last).toArray() : [],
      random > 0
        ? coll.aggregate([{ $match: filter }, { $sample: { size: random } }], { maxTimeMS }).toArray()
        : [],
    ]);
    const seen = new Set<string>();
    const documents = [];
    const counts = { first: 0, last: 0, random: 0 };
    for (const [source, docs] of [['first', head], ['last', tail], ['random', sampled]] as const) {
      for (const d of docs) {
        const key = JSON.stringify(toEjson(d._id ?? null));
        if (seen.has(key)) continue;
        seen.add(key);
        documents.push(d);
        counts[source] += 1;
      }
    }
    return {
      db: db.databaseName,
      collection,
      documents: toEjson(documents),
      counts,
      ms: Math.round(performance.now() - started),
    };
  });

  /** Index viewer: keys + options of every index on a collection. */
  app.get<{ Querystring: { db?: string; collection?: string } }>('/api/indexes', async (request) => {
    const collection = request.query.collection;
    if (!collection) throw badRequest('"collection" query parameter is required');
    const db = await dbFor(request, request.query.db || undefined);
    const indexes = await db.collection(collection).indexes();
    return { db: db.databaseName, collection, indexes: toEjson(indexes) };
  });

  /**
   * Distinct values + frequency counts for a (possibly nested) path across the
   * documents matching `filter`. Arrays along the path are unwound, so
   * `covers.loadings.code` counts every loading code. The scan is bounded by
   * `sampleLimit` documents and a server-side time limit to protect jump hosts.
   */
  app.post('/api/query/distinct', async (request) => {
    const body = asRecord(request.body, 'body');
    const collection = requireString(body, 'collection');
    const field = toMongoPath(requireString(body, 'field'));
    const segments = field.split('.');
    if (segments.some((s) => s === '' || s.startsWith('$'))) {
      throw badRequest('"field" must be a dotted field path like covers.loadings.code');
    }
    const filter = ejsonDocument(body, 'filter');
    const sampleLimit = boundedInt(body, 'sampleLimit', { fallback: 10_000, min: 1, max: 100_000 });
    const limit = boundedInt(body, 'limit', { fallback: 200, min: 1, max: 1_000 });
    const db = await dbFor(request, optionalString(body, 'db'));

    const unwinds = segments.map((_, i) => ({ $unwind: `$${segments.slice(0, i + 1).join('.')}` }));
    const started = performance.now();
    const rows = await db
      .collection(collection)
      .aggregate(
        [
          { $match: filter },
          { $limit: sampleLimit },
          { $project: { _id: 0, [field]: 1 } },
          ...unwinds,
          { $group: { _id: `$${field}`, count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
          { $limit: limit + 1 },
        ],
        { maxTimeMS: 10_000 },
      )
      .toArray();
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return {
      field,
      values: rows.map((r) => ({ value: toEjson(r._id), count: r.count as number })),
      hasMore,
      sampleLimit,
      ms: Math.round(performance.now() - started),
    };
  });

  /** Master-Detail via saved Relation Blueprint (batched $in, no $lookup). */
  app.post('/api/query/master-detail', async (request) => {
    const body = asRecord(request.body, 'body');
    let blueprint;
    try {
      blueprint = parseBlueprint(body.blueprint);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    const db = await dbFor(request, optionalString(body, 'db'));
    const result = await queryMasterDetail(db, {
      blueprint,
      filter: ejsonDocument(body, 'filter'),
      projection: ejsonDocument(body, 'projection'),
      sort: ejsonDocument(body, 'sort') as Sort,
      skip: boundedInt(body, 'skip', { fallback: 0, min: 0, max: 1_000_000 }),
      limit: boundedInt(body, 'limit', { fallback: DEFAULT_ROOT_LIMIT, min: 1, max: MAX_ROOT_LIMIT }),
      childLimit: boundedInt(body, 'childLimit', { fallback: DEFAULT_CHILD_LIMIT, min: 1, max: 20_000 }),
    });
    return {
      db: db.databaseName,
      blueprintId: result.blueprintId,
      roots: toEjson(result.roots),
      stats: result.stats,
    };
  });
}
