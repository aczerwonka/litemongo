import type { FastifyInstance } from 'fastify';
import type { Document, Sort } from 'mongodb';
import { MAX_ROOT_LIMIT, queryMasterDetail } from '../db/batcher.js';
import {
  buildBundle,
  identitySummary,
  insertBundle,
  parseBundle,
  remapBundle,
  serializeBundle,
  type RemapResult,
} from '../db/importer.js';
import { parseBlueprint, parseRenumberingRules, parseSchemas } from '../lib/config.js';
import { asRecord, badRequest, boundedInt, ejsonDocument, optionalString, requireString } from '../lib/http.js';
import { dbFor } from '../lib/mongoContext.js';
import { requireWritable } from '../middleware/readOnly.js';

/** Shared by dry-run and paste: parse bundle + config, optionally remap. */
function prepare(body: Record<string, unknown>): RemapResult {
  const bundleText = requireString(body, 'bundle');
  try {
    const bundle = parseBundle(bundleText);
    if (body.remap === false) return { bundle, summary: identitySummary(bundle) };
    return remapBundle(bundle, {
      schemas: parseSchemas(body.schemas),
      renumberingRules: parseRenumberingRules(body.renumberingRules),
    });
  } catch (err) {
    throw badRequest((err as Error).message);
  }
}

function countDocs(collections: Record<string, Document[]>): Record<string, number> {
  return Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length]));
}

export async function transferRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Export full documents (no projection — a partial doc must never be pasted)
   * as a canonical EJSON bundle string ready for the clipboard. With a blueprint,
   * the whole Master -> Detail -> Sub-detail graph is included.
   */
  app.post('/api/transfer/export', async (request) => {
    const body = asRecord(request.body, 'body');
    const db = await dbFor(request, optionalString(body, 'db'));
    const filter = ejsonDocument(body, 'filter');
    const sort = ejsonDocument(body, 'sort') as Sort;
    const limit = boundedInt(body, 'limit', { fallback: 100, min: 1, max: MAX_ROOT_LIMIT });

    let collections: Record<string, Document[]>;
    let blueprintId: string | undefined;
    if (body.blueprint !== undefined && body.blueprint !== null) {
      let blueprint;
      try {
        blueprint = parseBlueprint(body.blueprint);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
      const result = await queryMasterDetail(db, { blueprint, filter, sort, limit });
      collections = result.collections;
      blueprintId = blueprint.id;
    } else {
      const collection = requireString(body, 'collection');
      let cursor = db.collection(collection).find(filter);
      if (Object.keys(sort as object).length > 0) cursor = cursor.sort(sort);
      collections = { [collection]: await cursor.limit(limit).toArray() };
    }

    const bundle = buildBundle(collections, {
      sourceDb: db.databaseName,
      ...(blueprintId ? { blueprintId } : {}),
    });
    return { bundle: serializeBundle(bundle), counts: countDocs(collections) };
  });

  /**
   * Pre-paste preview. Pure computation — touches no database and needs no URI.
   * `preview` is the exact remapped bundle; paste it with `remap: false` to insert
   * precisely the ids shown here.
   */
  app.post('/api/transfer/dry-run', async (request) => {
    const body = asRecord(request.body, 'body');
    const { bundle, summary } = prepare(body);
    return { summary, preview: serializeBundle(bundle) };
  });

  app.post('/api/transfer/paste', { preHandler: requireWritable }, async (request) => {
    const body = asRecord(request.body, 'body');
    const { bundle, summary } = prepare(body);
    const db = await dbFor(request, optionalString(body, 'db'));
    const result = await insertBundle(db, bundle);
    return { result, summary };
  });
}
