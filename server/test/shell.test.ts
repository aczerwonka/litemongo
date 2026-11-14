import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const NO_DB_URI = 'mongodb://127.0.0.1:1/never_reached';
const uri = process.env.MONGO_TEST_URI;

describe('script mode operations', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildApp({ logger: false, clientDist: '/nonexistent' });
  });
  after(async () => {
    await app.close();
  });

  const op = (body: Record<string, unknown>, headers: Record<string, string> = {}, target = NO_DB_URI) =>
    app.inject({ method: 'POST', url: '/api/shell/op', headers: { 'x-mongo-uri': target, ...headers }, payload: body });

  it('rejects unknown operations', async () => {
    const res = await op({ op: 'dropDatabase', collection: 'x', args: {} });
    assert.equal(res.statusCode, 400);
  });

  it('blocks writes without X-Read-Only: false', async () => {
    const res = await op({ op: 'deleteMany', collection: 'policies', args: { filter: {} } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'READ_ONLY');
  });

  it('blocks $out / $merge aggregations on read-only connections', async () => {
    const res = await op({ op: 'aggregate', collection: 'policies', args: { pipeline: [{ $match: {} }, { $out: 'copy' }] } });
    assert.equal(res.statusCode, 403);
  });

  it('runs reads against MongoDB', { skip: !uri && 'MONGO_TEST_URI not set' }, async () => {
    const res = await op(
      { op: 'find', collection: 'policies', args: { filter: { policyNumber: 'POL-2026-0001' }, limit: 5 } },
      { 'x-read-only': 'true' },
      uri,
    );
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.result.length, 1);
    assert.deepEqual(body.result[0]._id, { $oid: '673400000000000000000001' });
  });

  it('samples first / last / random documents', { skip: !uri && 'MONGO_TEST_URI not set' }, async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/sample',
      headers: { 'x-mongo-uri': uri as string },
      payload: { collection: 'claim_items', first: 1, last: 1, random: 5 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.documents.length, 3); // 3 docs in the collection, de-duplicated
    assert.equal(body.counts.first, 1);
    assert.equal(body.counts.last, 1);
  });
});
