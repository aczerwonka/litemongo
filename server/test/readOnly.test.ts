import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { buildBundle, serializeBundle } from '../src/db/importer.js';
import { seedCollections } from './fixtures.js';

// No database is needed: the guard must reject before any connection is attempted.
const NO_DB_URI = 'mongodb://127.0.0.1:1/never_reached';
const payload = { bundle: serializeBundle(buildBundle(seedCollections())), remap: true };

describe('read-only guard', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildApp({ logger: false, clientDist: '/nonexistent' });
  });
  after(async () => {
    delete process.env.FORCE_READ_ONLY;
    await app.close();
  });

  const paste = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/transfer/paste', headers: { 'x-mongo-uri': NO_DB_URI, ...headers }, payload });

  it('blocks writes when X-Read-Only is missing (fail-closed)', async () => {
    const res = await paste({});
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'READ_ONLY');
  });

  it('blocks writes when X-Read-Only: true', async () => {
    assert.equal((await paste({ 'x-read-only': 'true' })).statusCode, 403);
  });

  it('blocks writes under FORCE_READ_ONLY even with X-Read-Only: false', async () => {
    process.env.FORCE_READ_ONLY = 'true';
    try {
      const res = await paste({ 'x-read-only': 'false' });
      assert.equal(res.statusCode, 403);
      assert.match(res.json().message, /FORCE_READ_ONLY/);
    } finally {
      delete process.env.FORCE_READ_ONLY;
    }
  });

  it('lets X-Read-Only: false through to the handler', async () => {
    const res = await paste({ 'x-read-only': 'false' });
    // Passes the guard, then fails to connect to the unreachable test URI.
    assert.equal(res.statusCode, 502);
    assert.doesNotMatch(res.body, /never_reached@|127\.0\.0\.1:1\/never_reached/);
  });

  it('does not guard the dry-run preview', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/transfer/dry-run', payload });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().summary.totals.rootIdsRemapped, 7);
  });

  it('redacts credentials from connection errors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/connection/test',
      headers: { 'x-mongo-uri': 'mongodb://user:s3cret@127.0.0.1:1/x' },
    });
    assert.equal(res.statusCode, 502);
    assert.doesNotMatch(res.body, /s3cret/);
  });
});
