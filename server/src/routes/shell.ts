import type { FastifyInstance } from 'fastify';
import type { Document, Sort } from 'mongodb';
import { EJSON } from '../lib/bson.js';
import { asRecord, badRequest, HttpError, optionalString, toEjson } from '../lib/http.js';
import { dbFor } from '../lib/mongoContext.js';
import { isForceReadOnly, isRequestReadOnly } from '../middleware/readOnly.js';

/**
 * Free-query (script) mode backend.
 *
 * The script itself runs in the developer's browser (a Web Worker with a
 * mongosh-like `db` facade). Each collection method call lands here as one
 * operation; the server never evaluates user code. Reads are always allowed,
 * writes go through the same Read-Only guardrail as every other mutation.
 */

/** Hard cap on documents returned by a single find / aggregate call. */
export const SHELL_MAX_DOCS = 5_000;

const READ_OPS = new Set([
  'find',
  'findOne',
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'getIndexes',
  'listCollections',
]);
const WRITE_OPS = new Set(['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany']);

export const SHELL_OPS = [...READ_OPS, ...WRITE_OPS];

function doc(args: Record<string, unknown>, key: string): Document {
  const v = args[key];
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest(`"${key}" must be an object`);
  return v as Document;
}

function int(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`"${key}" must be a non-negative number`);
  return Math.min(Math.floor(n), max);
}

function pipelineWrites(pipeline: Document[]): boolean {
  return pipeline.some((stage) => '$out' in stage || '$merge' in stage);
}

export async function shellRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/shell/op', async (request, reply) => {
    const body = asRecord(request.body, 'body');
    const op = typeof body.op === 'string' ? body.op : '';
    if (!READ_OPS.has(op) && !WRITE_OPS.has(op)) {
      throw badRequest(`Unsupported operation "${op}". Supported: ${SHELL_OPS.join(', ')}`);
    }
    let args: Record<string, unknown>;
    try {
      args = asRecord(EJSON.deserialize(asRecord(body.args, 'args'), { relaxed: false }), 'args');
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw badRequest(`"args" is not valid Extended JSON: ${(err as Error).message}`);
    }

    const pipeline = Array.isArray(args.pipeline) ? (args.pipeline as Document[]) : [];
    const writes = WRITE_OPS.has(op) || (op === 'aggregate' && pipelineWrites(pipeline));
    if (writes && isRequestReadOnly(request)) {
      const reason = isForceReadOnly() ? 'FORCE_READ_ONLY is enabled on this LiteMongo instance' : 'connection is in Read-Only mode';
      return reply.code(403).send({ error: 'READ_ONLY', message: `Write blocked (${op}): ${reason}.` });
    }

    const db = await dbFor(request, optionalString(body, 'db'));
    const started = performance.now();
    const done = (result: unknown, extra: Record<string, unknown> = {}) => ({
      op,
      result: toEjson(result),
      ms: Math.round(performance.now() - started),
      ...extra,
    });

    if (op === 'listCollections') {
      const cols = await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray();
      return done(cols.map((c) => c.name).filter((n) => !n.startsWith('system.')).sort());
    }

    const name = optionalString(body, 'collection');
    if (!name) throw badRequest('"collection" is required');
    const coll = db.collection(name);
    const maxTimeMS = 30_000;

    switch (op) {
      case 'find': {
        const limit = int(args, 'limit', SHELL_MAX_DOCS, SHELL_MAX_DOCS) || SHELL_MAX_DOCS;
        let cursor = coll.find(doc(args, 'filter'), { maxTimeMS });
        const projection = doc(args, 'projection');
        const sort = doc(args, 'sort') as Sort;
        if (Object.keys(projection).length > 0) cursor = cursor.project(projection);
        if (Object.keys(sort as object).length > 0) cursor = cursor.sort(sort);
        const docs = await cursor.skip(int(args, 'skip', 0, 10_000_000)).limit(limit + 1).toArray();
        const hasMore = docs.length > limit;
        if (hasMore) docs.pop();
        return done(docs, { hasMore });
      }
      case 'findOne': {
        const projection = doc(args, 'projection');
        return done(await coll.findOne(doc(args, 'filter'), { maxTimeMS, ...(Object.keys(projection).length ? { projection } : {}) }));
      }
      case 'aggregate': {
        const docs = await coll.aggregate(pipeline, { maxTimeMS, allowDiskUse: false }).limit(SHELL_MAX_DOCS + 1).toArray();
        const hasMore = docs.length > SHELL_MAX_DOCS;
        if (hasMore) docs.pop();
        return done(docs, { hasMore });
      }
      case 'countDocuments':
        return done(await coll.countDocuments(doc(args, 'filter'), { maxTimeMS }));
      case 'estimatedDocumentCount':
        return done(await coll.estimatedDocumentCount({ maxTimeMS }));
      case 'distinct': {
        const field = typeof args.field === 'string' ? args.field : '';
        if (!field) throw badRequest('distinct needs a field name');
        return done(await coll.distinct(field, doc(args, 'filter'), { maxTimeMS }));
      }
      case 'getIndexes':
        return done(await coll.indexes());
      case 'insertOne':
        return done(await coll.insertOne(doc(args, 'document')));
      case 'insertMany': {
        const docs = Array.isArray(args.documents) ? (args.documents as Document[]) : [];
        return done(await coll.insertMany(docs));
      }
      case 'updateOne':
        return done(await coll.updateOne(doc(args, 'filter'), updateArg(args), doc(args, 'options')));
      case 'updateMany':
        return done(await coll.updateMany(doc(args, 'filter'), updateArg(args), doc(args, 'options')));
      case 'replaceOne':
        return done(await coll.replaceOne(doc(args, 'filter'), doc(args, 'replacement'), doc(args, 'options')));
      case 'deleteOne':
        return done(await coll.deleteOne(doc(args, 'filter')));
      case 'deleteMany':
        return done(await coll.deleteMany(doc(args, 'filter')));
      default:
        throw badRequest(`Unsupported operation "${op}"`);
    }
  });
}

/** Update document or update pipeline. */
function updateArg(args: Record<string, unknown>): Document | Document[] {
  const u = args.update;
  if (Array.isArray(u)) return u as Document[];
  if (u && typeof u === 'object') return u as Document;
  throw badRequest('"update" must be an object or a pipeline array');
}
