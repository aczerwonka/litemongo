import { api, type ConnectionContext } from './api';
import { inferFields, type FieldMap } from './schema';

/**
 * Field trees inferred from sampled documents (first / last / random by _id),
 * cached per connection + db + collection for the session. Feeds autocomplete
 * for collections nobody has documented in the schema registry yet.
 */

export const SAMPLE_DEFAULTS = { first: 10, last: 10, random: 10 };

const cache = new Map<string, Promise<FieldMap>>();
const resolved = new Map<string, FieldMap>();

const keyOf = (conn: ConnectionContext, db: string, collection: string) => `${conn.uri}\u0000${db}\u0000${collection}`;

/** Sampled field tree, fetched once; resolves to {} on errors (autocomplete must never fail loudly). */
export function sampledFields(conn: ConnectionContext, db: string, collection: string): Promise<FieldMap> {
  const key = keyOf(conn, db, collection);
  let entry = cache.get(key);
  if (!entry) {
    entry = api
      .sample(conn, { db, collection, ...SAMPLE_DEFAULTS })
      .then((res) => {
        const fields = inferFields(res.documents).fields;
        resolved.set(key, fields);
        return fields;
      })
      .catch(() => {
        cache.delete(key);
        return {};
      });
    cache.set(key, entry);
  }
  return entry;
}

/** Already fetched field tree (synchronous peek), if any. */
export function peekSampledFields(conn: ConnectionContext, db: string, collection: string): FieldMap | undefined {
  return resolved.get(keyOf(conn, db, collection));
}

/** Collection names per connection + db (for `db.` completion in scripts). */
const collectionsCache = new Map<string, Promise<string[]>>();
export function collectionNames(conn: ConnectionContext, db: string): Promise<string[]> {
  const key = `${conn.uri}\u0000${db}`;
  let entry = collectionsCache.get(key);
  if (!entry) {
    entry = api
      .collections(conn, db)
      .then((r) => r.collections)
      .catch(() => {
        collectionsCache.delete(key);
        return [];
      });
    collectionsCache.set(key, entry);
    // Refresh after a minute so new collections show up.
    setTimeout(() => collectionsCache.delete(key), 60_000);
  }
  return entry;
}
