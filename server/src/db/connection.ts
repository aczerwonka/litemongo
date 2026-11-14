import { createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { HttpError } from '../lib/http.js';

/**
 * Stateless, short-lived MongoClient pool.
 *
 * - Entries are keyed by a SHA-256 hash of the incoming X-Mongo-URI header.
 *   The URI string itself is never stored by LiteMongo (not on disk, not in this
 *   map, not in logs). The live MongoClient necessarily holds it in memory for
 *   the lifetime of its sockets, and is closed after IDLE_TTL_MS of inactivity.
 * - Concurrent first requests for the same URI share one connect() promise.
 */

const IDLE_TTL_MS = Number(process.env.MONGO_CLIENT_IDLE_TTL_MS ?? 5 * 60 * 1000);
const MAX_CLIENTS = Number(process.env.MONGO_MAX_CLIENTS ?? 32);
const URI_PATTERN = /^mongodb(\+srv)?:\/\//i;

interface PoolEntry {
  client: Promise<MongoClient>;
  lastUsed: number;
  timer: NodeJS.Timeout;
}

const pool = new Map<string, PoolEntry>();

export function hashUri(uri: string): string {
  return createHash('sha256').update(uri).digest('hex');
}

/** Remove credentials from any text that might echo a connection string. */
export function redactUri(text: string): string {
  return text.replace(/(mongodb(?:\+srv)?:\/\/)[^@/\s]+@/gi, '$1***@');
}

function scheduleEviction(key: string, entry: PoolEntry): void {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    void evict(key);
  }, IDLE_TTL_MS);
  entry.timer.unref();
}

async function evict(key: string): Promise<void> {
  const entry = pool.get(key);
  if (!entry) return;
  pool.delete(key);
  clearTimeout(entry.timer);
  try {
    const client = await entry.client;
    await client.close();
  } catch {
    // connect failed or already closed — nothing to clean up
  }
}

function evictLeastRecentlyUsed(): void {
  let oldestKey: string | undefined;
  let oldest = Infinity;
  for (const [key, entry] of pool) {
    if (entry.lastUsed < oldest) {
      oldest = entry.lastUsed;
      oldestKey = key;
    }
  }
  if (oldestKey) void evict(oldestKey);
}

export async function getClient(uri: string): Promise<MongoClient> {
  if (!URI_PATTERN.test(uri)) {
    throw new HttpError(400, 'X-Mongo-URI must start with mongodb:// or mongodb+srv://');
  }
  const key = hashUri(uri);
  const existing = pool.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    scheduleEviction(key, existing);
    return existing.client;
  }

  if (pool.size >= MAX_CLIENTS) evictLeastRecentlyUsed();

  let client: MongoClient;
  try {
    client = new MongoClient(uri, {
      appName: 'litemongo',
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
      maxPoolSize: 10,
      maxIdleTimeMS: IDLE_TTL_MS,
    });
  } catch (err) {
    // Invalid URI options: report without echoing the URI.
    throw new HttpError(400, `Invalid connection string: ${redactUri((err as Error).message)}`);
  }

  const connecting = client.connect().catch((err: unknown) => {
    // Do not cache failed connections; the next request retries cleanly.
    const entry = pool.get(key);
    if (entry && entry.client === connecting) {
      clearTimeout(entry.timer);
      pool.delete(key);
    }
    throw new HttpError(502, `Cannot connect to MongoDB: ${redactUri((err as Error).message)}`);
  });

  const entry: PoolEntry = {
    client: connecting,
    lastUsed: Date.now(),
    timer: setTimeout(() => undefined, 0),
  };
  pool.set(key, entry);
  scheduleEviction(key, entry);
  return connecting;
}

/** Drop a cached client explicitly (e.g. user clicked "Disconnect"). */
export async function releaseClient(uri: string): Promise<boolean> {
  const key = hashUri(uri);
  const had = pool.has(key);
  await evict(key);
  return had;
}

export async function closeAllClients(): Promise<void> {
  await Promise.all([...pool.keys()].map((key) => evict(key)));
}

export function poolStats(): { activeClients: number; idleTtlMs: number } {
  return { activeClients: pool.size, idleTtlMs: IDLE_TTL_MS };
}
