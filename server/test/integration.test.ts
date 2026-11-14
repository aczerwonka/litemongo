import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { EJSON, ObjectId } from '../src/lib/bson.js';
import type { FastifyInstance } from 'fastify';
import { MongoClient, type Document } from 'mongodb';
import { buildApp } from '../src/app.js';
import { blueprint, exampleConfig } from './fixtures.js';

/**
 * Runs against the seeded docker-compose MongoDB. Set MONGO_TEST_URI, e.g.
 *   MONGO_TEST_URI='mongodb://admin:localpassword@localhost:27017/insurance_dev?authSource=admin'
 * Reads insurance_dev; writes only to a throwaway database that it drops afterwards.
 */
const uri = process.env.MONGO_TEST_URI;
const scratchDb = `litemongo_test_${Date.now()}`;

describe('backend against local MongoDB', { skip: !uri && 'MONGO_TEST_URI not set' }, () => {
  let app: FastifyInstance;
  let direct: MongoClient;
  const headers = (readOnly = true) => ({ 'x-mongo-uri': uri as string, 'x-read-only': String(readOnly) });

  before(async () => {
    app = await buildApp({ logger: false, clientDist: '/nonexistent' });
    direct = new MongoClient(uri as string);
    await direct.connect();
  });
  after(async () => {
    await direct.db(scratchDb).dropDatabase();
    await direct.close();
    await app.close();
  });

  it('tests the connection', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/connection/test', headers: headers() });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.match(body.serverVersion, /^8\./);
    assert.equal(body.defaultDb, 'insurance_dev');
    assert.ok(body.databases.includes('insurance_dev'));
  });

  it('lists collections', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/databases/insurance_dev/collections', headers: headers() });
    // The rich seed (mongo-seed-rich.js) adds more collections; the base three must be there.
    const names: string[] = res.json().collections;
    for (const name of ['claim_items', 'claims', 'policies']) assert.ok(names.includes(name), name);
  });

  it('runs the saved query preset and returns canonical EJSON', async () => {
    const preset = exampleConfig.queryPresets?.[0] as { collection: string; filter: Document; projection: Document };
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/find',
      headers: headers(),
      payload: { collection: preset.collection, filter: preset.filter, projection: preset.projection },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.returned, 1);
    assert.equal(body.documents[0].policyNumber, 'POL-2026-0001');
    assert.deepEqual(body.documents[0].totalPremium, { $numberDecimal: '1450.50' });
  });

  it('accepts EJSON filters ($oid) and reports hasMore', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/find',
      headers: headers(),
      payload: { collection: 'claim_items', filter: { claimId: { $oid: '673400000000000000000101' } }, limit: 1 },
    });
    const body = res.json();
    assert.equal(body.returned, 1);
    assert.equal(body.hasMore, true);
  });

  it('lists collection indexes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/indexes?db=insurance_dev&collection=policies',
      headers: headers(),
    });
    assert.equal(res.statusCode, 200, res.body);
    const names = (res.json().indexes as { name: string }[]).map((i) => i.name);
    assert.ok(names.includes('_id_'));
  });

  it('counts distinct values through nested arrays', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/distinct',
      headers: headers(),
      payload: { collection: 'policies', field: 'covers[].loadings[].code' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const values = res.json().values as { value: unknown; count: number }[];
    assert.ok(values.some((v) => v.value === 'LOAD_YOUNG_DRIVER' && v.count >= 1));

    const bad = await app.inject({
      method: 'POST',
      url: '/api/query/distinct',
      headers: headers(),
      payload: { collection: 'policies', field: '$where' },
    });
    assert.equal(bad.statusCode, 400);
  });

  it('stitches 3 levels with exactly 3 queries (batched $in)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/master-detail',
      headers: headers(),
      payload: { blueprint, sort: { policyNumber: 1 } },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.stats.queries, 3);
    const roots = EJSON.deserialize(body.roots) as Document[];
    assert.equal(roots.length, 2);
    const claims = roots[0]?.children.claims as Document[];
    assert.equal(claims.length, 2);
    const items = claims.find((c) => c.doc.claimNumber === 'CLM-2026-8801')?.children.claim_items as Document[];
    assert.deepEqual(items.map((i) => i.doc.code).sort(), ['ITEM_REPAIR', 'ITEM_TOWING']);
    assert.deepEqual(roots[1]?.children.claims, []);
  });

  it('keeps the join key when the projection excludes it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/master-detail',
      headers: headers(),
      payload: { blueprint, projection: { policyNumber: 1, _id: 0 }, filter: { policyNumber: 'POL-2026-0001' } },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().stats.levels[0].docCount, 2);
  });

  it('exports a graph, previews the remap, and pastes it with links intact', async () => {
    const exported = await app.inject({
      method: 'POST',
      url: '/api/transfer/export',
      headers: headers(),
      payload: { blueprint, filter: { policyNumber: 'POL-2026-0001' } },
    });
    assert.equal(exported.statusCode, 200, exported.body);
    const { bundle, counts } = exported.json();
    assert.deepEqual(counts, { policies: 1, claims: 2, claim_items: 3 });

    const transferConfig = {
      schemas: exampleConfig.schemas,
      renumberingRules: exampleConfig.renumberingRules,
    };
    const dry = await app.inject({ method: 'POST', url: '/api/transfer/dry-run', payload: { bundle, ...transferConfig } });
    const { summary } = dry.json();
    assert.equal(summary.totals.rootIdsRemapped, 6);
    assert.equal(summary.totals.foreignKeysRewritten, 2 + 6);

    // Read-only connection: paste is refused.
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/transfer/paste',
      headers: headers(true),
      payload: { bundle, db: scratchDb, ...transferConfig },
    });
    assert.equal(blocked.statusCode, 403);

    // Paste exactly what the preview showed (remap: false on the preview bundle).
    const pasted = await app.inject({
      method: 'POST',
      url: '/api/transfer/paste',
      headers: headers(false),
      payload: { bundle: dry.json().preview, remap: false, db: scratchDb },
    });
    assert.equal(pasted.statusCode, 200, pasted.body);
    assert.equal(pasted.json().result.inserted, 6);

    const db = direct.db(scratchDb);
    const policy = (await db.collection('policies').findOne({})) as Document;
    assert.ok(policy._id instanceof ObjectId);
    assert.notEqual(policy._id.toHexString(), '673400000000000000000001');
    assert.match(policy.policyNumber as string, /^POL-LOCAL-/);
    assert.equal(policy.totalPremium._bsontype, 'Decimal128');
    const claims = await db.collection('claims').find({ policyId: policy._id }).toArray();
    assert.equal(claims.length, 2);
    const items = await db
      .collection('claim_items')
      .find({ claimId: { $in: claims.map((c) => c._id) } })
      .toArray();
    assert.equal(items.length, 3);
    const coverIds = (policy.covers as Document[]).map((c) => c.coverId);
    assert.ok(items.every((i) => coverIds.includes(i.coverId)));
    assert.deepEqual((policy.covers as Document[]).map((c) => c.code), ['COVER_COLLISION', 'COVER_GLASS']);

    // Pasting the same preview again collides on _id and is reported, not thrown.
    const again = await app.inject({
      method: 'POST',
      url: '/api/transfer/paste',
      headers: headers(false),
      payload: { bundle: dry.json().preview, remap: false, db: scratchDb },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().result.failed, 6);
    assert.match(again.json().result.collections.policies.errors[0], /^Duplicate key/);
  });
});
