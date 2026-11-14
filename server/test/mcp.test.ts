import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Compact: HTTP header values cannot contain newlines.
const configText = JSON.stringify(JSON.parse(readFileSync(path.resolve(here, '../../litemongo.config.example.json'), 'utf8')));
const uri = process.env.MONGO_TEST_URI;

const MCP_HEADERS = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };

describe('MCP endpoint (/mcp)', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildApp({ logger: false, clientDist: '/nonexistent' });
  });
  after(async () => {
    await app.close();
  });

  let nextId = 1;
  const rpc = async (method: string, params: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...MCP_HEADERS, ...headers },
      payload: { jsonrpc: '2.0', id: nextId++, method, params },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { result?: Record<string, unknown>; error?: { message: string } };
  };
  const callTool = async (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const body = await rpc('tools/call', { name, arguments: args }, headers);
    const result = body.result as { isError?: boolean; content: { type: string; text: string }[] };
    return { isError: !!result.isError, text: result.content[0]?.text ?? '' };
  };

  it('initializes and lists exactly the three read-only tools', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal((init.result?.serverInfo as { name: string }).name, 'litemongo');

    const list = await rpc('tools/list', {});
    const tools = list.result?.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    assert.deepEqual(tools.map((t) => t.name).sort(), ['list_relations', 'list_schemas', 'query_master_detail']);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  });

  it('serves schemas and relations from the X-LiteMongo-Config header (base64)', async () => {
    const headers = { 'x-litemongo-config': Buffer.from(configText).toString('base64') };
    const schemas = await callTool('list_schemas', { collection: 'policies' }, headers);
    assert.equal(schemas.isError, false);
    const parsed = JSON.parse(schemas.text) as { policies: { coreFields: { covers: { items: object } } } };
    assert.ok('loadings' in parsed.policies.coreFields.covers.items);

    const relations = await callTool('list_relations', {}, headers);
    assert.match(relations.text, /policy-claims-hierarchy/);
  });

  it('reports a missing config / connection as a tool error, not a crash', async () => {
    const empty = await callTool('list_relations', {});
    assert.deepEqual(JSON.parse(empty.text), { relationBlueprints: [] });

    const noUri = await callTool(
      'query_master_detail',
      { blueprintId: 'policy-claims-hierarchy' },
      { 'x-litemongo-config': configText },
    );
    assert.equal(noUri.isError, true);
    assert.match(noUri.text, /X-Mongo-URI/);
  });

  it('rejects GET (stateless transport, no standalone SSE stream)', async () => {
    const res = await app.inject({ method: 'GET', url: '/mcp' });
    assert.equal(res.statusCode, 405);
  });

  it('stitches the 3-level hierarchy read-only', { skip: !uri && 'MONGO_TEST_URI not set' }, async () => {
    const res = await callTool(
      'query_master_detail',
      { blueprintId: 'policy-claims-hierarchy', filter: { policyNumber: 'POL-2026-0001' } },
      { 'x-litemongo-config': configText, 'x-mongo-uri': uri as string },
    );
    assert.equal(res.isError, false, res.text);
    const body = JSON.parse(res.text) as {
      stats: { queries: number };
      roots: { document: { policyNumber: string; _id: unknown }; children: { claims: { children: { claim_items: unknown[] } }[] } }[];
    };
    assert.equal(body.stats.queries, 3);
    assert.equal(body.roots.length, 1);
    assert.equal(body.roots[0]?.document.policyNumber, 'POL-2026-0001');
    assert.deepEqual(body.roots[0]?.document._id, { $oid: '673400000000000000000001' });
    assert.ok((body.roots[0]?.children.claims[0]?.children.claim_items.length ?? 0) > 0);
  });
});
