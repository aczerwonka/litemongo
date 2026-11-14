import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Document, Sort } from 'mongodb';
import { z } from 'zod';
import { queryMasterDetail, type MasterDetailNode } from '../db/batcher.js';
import { getClient, redactUri } from '../db/connection.js';
import { EJSON } from '../lib/bson.js';
import { parseBlueprint, type RelationBlueprint } from '../lib/config.js';
import { defaultDbFromUri } from '../lib/mongoContext.js';

/**
 * Embedded, strictly read-only MCP server mounted on /mcp (Streamable HTTP).
 *
 * Stateless like the rest of LiteMongo: every HTTP request gets a fresh
 * McpServer + transport (no MCP sessions, nothing kept between calls).
 *
 * Inputs, per request:
 *  - X-Mongo-URI      connection string (only needed by query_master_detail);
 *                     used, never stored or logged — same contract as /api.
 *  - X-Mongo-DB       optional database (else the URI path, else the tool's `db` arg).
 *  - X-LiteMongo-Config  optional workspace config: JSON, or base64 of the JSON.
 * Fallback config: the file named by LITEMONGO_CONFIG (a mounted, credential-free
 * litemongo.config.json). The MCP endpoint never writes, whatever the headers say.
 */

const MAX_ROOTS = 100;
const MAX_CHILDREN = 2_000;
const MAX_OUTPUT_CHARS = 400_000;

interface McpConfig {
  workspaceName?: string;
  schemas: Record<string, unknown>;
  relationBlueprints: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

function normaliseConfig(raw: unknown, source: string): McpConfig {
  if (!isRecord(raw)) throw new Error(`${source}: config must be a JSON object`);
  if (raw.schemas !== undefined && !isRecord(raw.schemas)) throw new Error(`${source}: "schemas" must be an object`);
  if (raw.relationBlueprints !== undefined && !Array.isArray(raw.relationBlueprints)) {
    throw new Error(`${source}: "relationBlueprints" must be an array`);
  }
  return {
    ...(typeof raw.workspaceName === 'string' ? { workspaceName: raw.workspaceName } : {}),
    schemas: (raw.schemas as Record<string, unknown> | undefined) ?? {},
    relationBlueprints: (raw.relationBlueprints as unknown[] | undefined) ?? [],
  };
}

let fileConfigCache: { path: string; config: McpConfig } | undefined;

function fileConfig(): McpConfig | undefined {
  const path = process.env.LITEMONGO_CONFIG?.trim();
  if (!path) return undefined;
  if (fileConfigCache?.path !== path) {
    const text = readFileSync(path, 'utf8');
    fileConfigCache = { path, config: normaliseConfig(JSON.parse(text), 'LITEMONGO_CONFIG') };
  }
  return fileConfigCache.config;
}

/** Header config wins over the mounted file; both are optional. */
export function resolveMcpConfig(request: FastifyRequest): McpConfig {
  const raw = header(request, 'x-litemongo-config');
  if (raw) {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('X-LiteMongo-Config is neither JSON nor base64-encoded JSON');
    }
    return normaliseConfig(parsed, 'X-LiteMongo-Config');
  }
  return fileConfig() ?? { schemas: {}, relationBlueprints: [] };
}

function textResult(value: unknown): CallToolResult {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [output truncated at ${MAX_OUTPUT_CHARS} characters; lower "limit" or narrow "filter"]`;
  }
  return { content: [{ type: 'text', text }] };
}

function errorResult(err: unknown): CallToolResult {
  const message = redactUri(err instanceof Error ? err.message : String(err));
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Relaxed EJSON keeps ObjectId/Date/Decimal128 typed but reads naturally for an LLM. */
function relaxed(value: unknown): unknown {
  return EJSON.serialize(value, { relaxed: true });
}

function nodeToJson(node: MasterDetailNode): unknown {
  const children = Object.fromEntries(
    Object.entries(node.children).map(([collection, list]) => [collection, list.map(nodeToJson)]),
  );
  return { collection: node.collection, document: relaxed(node.doc), children };
}

/** Accept a filter/projection/sort as an Extended JSON object or string. */
function ejsonArg(value: unknown, name: string): Document {
  if (value === undefined || value === null || value === '') return {};
  try {
    const parsed: unknown =
      typeof value === 'string'
        ? EJSON.parse(value, { relaxed: false })
        : EJSON.deserialize(value as Document, { relaxed: false });
    if (!isRecord(parsed)) throw new Error('must be an object');
    return parsed as Document;
  } catch (err) {
    throw new Error(`"${name}" is not valid Extended JSON: ${(err as Error).message}`);
  }
}

const ejsonInput = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .optional()
  .describe('Extended JSON object (e.g. {"policyId": {"$oid": "…"}}) or the same as a JSON string');

export function createMcpServer(request: FastifyRequest): McpServer {
  const server = new McpServer(
    { name: 'litemongo', version: '0.1.0' },
    {
      instructions:
        'LiteMongo exposes a MongoDB workspace read-only. Call list_schemas to learn documented fields ' +
        'and {code,value} enums, list_relations to see saved Master-Detail relation blueprints, then ' +
        'query_master_detail to fetch a stitched 2-3 level hierarchy with batched $in queries.',
    },
  );
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    'list_schemas',
    {
      title: 'List documented collection schemas',
      description:
        'Returns the documented collection schemas from litemongo.config.json: core/non-changing fields, ' +
        'BSON types, enum code dictionaries, id paths, protected code paths and soft foreign keys.',
      inputSchema: { collection: z.string().optional().describe('Only return this collection') },
      annotations: readOnly,
    },
    async ({ collection }) => {
      try {
        const config = resolveMcpConfig(request);
        if (collection) {
          const schema = config.schemas[collection];
          if (schema === undefined) {
            return errorResult(
              `No schema documented for "${collection}". Known: ${Object.keys(config.schemas).join(', ') || '(none)'}`,
            );
          }
          return textResult({ [collection]: schema });
        }
        return textResult({ workspaceName: config.workspaceName ?? null, schemas: config.schemas });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_relations',
    {
      title: 'List relation blueprints',
      description:
        'Returns saved Master-Detail relation blueprints (root collection plus linked collections, up to 3 levels deep, joined by ' +
        'localField -> foreignField). Use a blueprint id with query_master_detail.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      try {
        return textResult({ relationBlueprints: resolveMcpConfig(request).relationBlueprints });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'query_master_detail',
    {
      title: 'Query a Master-Detail hierarchy (read-only)',
      description:
        'Runs a read-only query on the blueprint root collection and stitches child levels with one batched ' +
        '$in query per level (no $lookup). Returns documents as relaxed Extended JSON nested by collection. ' +
        'Requires the X-Mongo-URI header on the MCP connection.',
      inputSchema: {
        blueprintId: z.string().describe('Relation blueprint id from list_relations'),
        filter: ejsonInput,
        projection: ejsonInput,
        sort: ejsonInput,
        limit: z.number().int().min(1).max(MAX_ROOTS).optional().describe(`Root documents (default 20, max ${MAX_ROOTS})`),
        childLimit: z
          .number()
          .int()
          .min(1)
          .max(MAX_CHILDREN)
          .optional()
          .describe(`Max documents per child level (default 500, max ${MAX_CHILDREN})`),
        db: z.string().optional().describe('Database name (defaults to X-Mongo-DB or the URI path)'),
      },
      annotations: { ...readOnly, openWorldHint: true },
    },
    async (args) => {
      try {
        const config = resolveMcpConfig(request);
        const raw = config.relationBlueprints.find((b) => isRecord(b) && b.id === args.blueprintId);
        if (!raw) {
          const ids = config.relationBlueprints.map((b) => (isRecord(b) ? String(b.id) : '?'));
          return errorResult(`Unknown blueprint "${args.blueprintId}". Known: ${ids.join(', ') || '(none)'}`);
        }
        const blueprint: RelationBlueprint = parseBlueprint(raw);
        const uri = header(request, 'x-mongo-uri');
        if (!uri) return errorResult('Missing X-Mongo-URI header on the MCP connection');
        const dbName = args.db ?? header(request, 'x-mongo-db') ?? defaultDbFromUri(uri);
        if (!dbName) return errorResult('No database: pass "db", send X-Mongo-DB, or put it in the URI path');

        const client = await getClient(uri);
        const result = await queryMasterDetail(client.db(dbName), {
          blueprint,
          filter: ejsonArg(args.filter, 'filter'),
          projection: ejsonArg(args.projection, 'projection'),
          sort: ejsonArg(args.sort, 'sort') as Sort,
          limit: args.limit ?? 20,
          childLimit: args.childLimit ?? 500,
        });
        return textResult({
          db: dbName,
          blueprintId: result.blueprintId,
          stats: result.stats,
          roots: result.roots.map(nodeToJson),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  // Stateless Streamable HTTP: POST carries JSON-RPC; there is no standalone
  // SSE stream (GET) and no session to delete (DELETE).
  app.post('/mcp', async (request, reply) => {
    const server = createMcpServer(request);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      request.log.error({ err: redactUri((err as Error).message) }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }),
        );
      }
    }
  });

  const notAllowed = { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null };
  app.get('/mcp', async (_request, reply) => reply.code(405).header('allow', 'POST').send(notAllowed));
  app.delete('/mcp', async (_request, reply) => reply.code(405).header('allow', 'POST').send(notAllowed));
}
