import type {
  EjsonDoc,
  LevelStats,
  MasterDetailNode,
  PasteResult,
  Recipe,
  RecipeRunResponse,
  RelationBlueprint,
  RemapSummary,
  WorkspaceConfig,
} from '../types';

/** What a request needs to know about a connection. Sent per request, never stored server-side. */
export interface ConnectionContext {
  uri: string;
  readOnly: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { conn?: ConnectionContext; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.conn) {
    headers['X-Mongo-URI'] = options.conn.uri;
    headers['X-Read-Only'] = options.conn.readOnly ? 'true' : 'false';
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the LiteMongo server');
  }
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // non-JSON error page
  }
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? 'HTTP_ERROR', err.message ?? `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export interface FindParams {
  db: string;
  collection: string;
  filter: EjsonDoc;
  projection: EjsonDoc;
  sort: EjsonDoc;
  limit: number;
  skip?: number;
}

export interface FindResponse {
  documents: EjsonDoc[];
  returned: number;
  hasMore: boolean;
  ms: number;
}

export interface MasterDetailResponse {
  roots: MasterDetailNode[];
  stats: { queries: number; totalMs: number; levels: LevelStats[] };
}

/** One entry of collection.indexes(), as canonical EJSON. */
export interface IndexInfo {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: unknown;
  partialFilterExpression?: Record<string, unknown>;
  collation?: Record<string, unknown>;
  hidden?: boolean;
  [option: string]: unknown;
}

export interface DistinctValue {
  value: unknown;
  count: number;
}

export interface DistinctResponse {
  field: string;
  values: DistinctValue[];
  hasMore: boolean;
  sampleLimit: number;
  ms: number;
}

export interface SampleParams {
  db: string;
  collection: string;
  first?: number;
  last?: number;
  random?: number;
  filter?: EjsonDoc;
}

export interface SampleResponse {
  documents: EjsonDoc[];
  counts: { first: number; last: number; random: number };
  ms: number;
}

type TransferConfig =Pick<WorkspaceConfig, 'schemas' | 'renumberingRules'>;

export const api = {
  health: () => call<{ ok: boolean; forceReadOnly: boolean }>('GET', '/api/health'),

  testConnection: (conn: ConnectionContext) =>
    call<{ serverVersion: string; pingMs: number; defaultDb: string | null; databases: string[] | null }>(
      'POST',
      '/api/connection/test',
      { conn },
    ),

  /** Close the server's cached client for this URI now (Disconnect). */
  releaseConnection: (conn: ConnectionContext) => call<{ released: boolean }>('POST', '/api/connection/release', { conn }),

  databases: (conn: ConnectionContext) => call<{ databases: string[] }>('GET', '/api/databases', { conn }),

  collections: (conn: ConnectionContext, db: string) =>
    call<{ collections: string[] }>('GET', `/api/databases/${encodeURIComponent(db)}/collections`, { conn }),

  find: (conn: ConnectionContext, params: FindParams) =>
    call<FindResponse>('POST', '/api/query/find', { conn, body: params }),

  masterDetail: (conn: ConnectionContext, params: Omit<FindParams, 'collection'> & { blueprint: RelationBlueprint }) =>
    call<MasterDetailResponse>('POST', '/api/query/master-detail', { conn, body: params }),

  /** Run a fetch recipe (multi-step template); read-only. */
  runRecipe: (conn: ConnectionContext, params: { db: string; recipe: Recipe; params: Record<string, string> }) =>
    call<RecipeRunResponse>('POST', '/api/recipe/run', { conn, body: params }),

  /** Schema sample: first / last N by _id plus N random documents. */
  sample: (conn: ConnectionContext, params: SampleParams) =>
    call<SampleResponse>('POST', '/api/query/sample', { conn, body: params }),

  indexes: (conn: ConnectionContext, db: string, collection: string) =>
    call<{ indexes: IndexInfo[] }>(
      'GET',
      `/api/indexes?db=${encodeURIComponent(db)}&collection=${encodeURIComponent(collection)}`,
      { conn },
    ),

  distinct: (
    conn: ConnectionContext,
    params: { db: string; collection: string; field: string; filter: EjsonDoc; sampleLimit?: number },
  ) => call<DistinctResponse>('POST', '/api/query/distinct', { conn, body: params }),

  exportBundle: (
    conn: ConnectionContext,
    params: { db: string; collection: string; filter: EjsonDoc; sort: EjsonDoc; limit: number; blueprint?: RelationBlueprint },
  ) => call<{ bundle: string; counts: Record<string, number> }>('POST', '/api/transfer/export', { conn, body: params }),

  dryRun: (params: { bundle: string; remap: boolean } & TransferConfig) =>
    call<{ summary: RemapSummary; preview: string }>('POST', '/api/transfer/dry-run', { body: params }),

  paste: (conn: ConnectionContext, params: { bundle: string; remap: boolean; db: string } & TransferConfig) =>
    call<{ result: PasteResult; summary: RemapSummary }>('POST', '/api/transfer/paste', { conn, body: params }),
};

/** Database name from the URI path (mongodb://host/<db>?…). */
export function defaultDbFromUri(uri: string): string | null {
  const match = /^mongodb(?:\+srv)?:\/\/[^/?]+\/([^?]+)/i.exec(uri);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** URI with the password hidden, for display. */
export function maskUri(uri: string): string {
  return uri.replace(/(mongodb(?:\+srv)?:\/\/[^:@/]+:)[^@/]+@/i, '$1••••@');
}
