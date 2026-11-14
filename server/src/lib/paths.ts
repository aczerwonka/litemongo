import { Binary, ObjectId, UUID } from './bson.js';

/**
 * Field paths in litemongo.config.json use `[]` to mark array traversal, e.g.
 * `covers[].coverId`. MongoDB dotted paths (`covers.coverId`) traverse arrays
 * implicitly. Both are accepted; internally we normalise to the `[]` form when
 * walking documents and to the dotted form when building MongoDB queries.
 */
export function toMongoPath(path: string): string {
  return path.replace(/\[\]/g, '');
}

export function toConfigPathSegments(path: string): string[] {
  return path.replace(/\[\]/g, '').split('.').filter(Boolean);
}

/**
 * Collect every value reachable at `path`, flattening arrays along the way —
 * the same semantics MongoDB applies to `{ "covers.coverId": ... }`.
 * A leaf that is itself an array contributes each of its elements.
 */
export function getPathValues(doc: unknown, path: string): unknown[] {
  const segments = toConfigPathSegments(path);
  const out: unknown[] = [];
  const visit = (node: unknown, i: number): void => {
    if (node === undefined || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, i);
      return;
    }
    if (i === segments.length) {
      out.push(node);
      return;
    }
    if (!isPlainObject(node)) return;
    visit(node[segments[i] as string], i + 1);
  };
  visit(doc, 0);
  return out;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // BSON value classes (ObjectId, Decimal128, Binary, ...) carry _bsontype.
  if ('_bsontype' in value) return false;
  if (value instanceof Date) return false;
  return true;
}

/**
 * Type-tagged identity key for a BSON value, so ObjectId("abc…") and the
 * string "abc…" never collide, and Int32(5) differs from Long(5).
 */
export function typedKey(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof ObjectId) return `oid:${value.toHexString()}`;
  if (value instanceof Binary) {
    // UUID extends Binary; EJSON may yield either class for subtype 4.
    const hex = Buffer.from(value.buffer).toString('hex');
    return value.sub_type === Binary.SUBTYPE_UUID ? `uuid:${hex}` : `bin${value.sub_type}:${hex}`;
  }
  if (typeof value === 'string') return `str:${value}`;
  if (typeof value === 'number') return `num:${value}`;
  if (typeof value === 'bigint') return `big:${value}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === 'object' && '_bsontype' in value) {
    const bsonType = (value as { _bsontype: string })._bsontype;
    return `${bsonType}:${String(value)}`;
  }
  return undefined;
}

/** Human-readable BSON type name used in previews. */
export function bsonTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) return 'Date';
  if (value instanceof Binary && value.sub_type === Binary.SUBTYPE_UUID) return 'UUID';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object' && '_bsontype' in value) {
    return (value as { _bsontype: string })._bsontype;
  }
  return typeof value;
}

/** Short display string for a BSON value (previews, warnings). */
export function displayValue(value: unknown): string {
  if (value instanceof ObjectId) return `ObjectId("${value.toHexString()}")`;
  if (value instanceof Binary && value.sub_type === Binary.SUBTYPE_UUID) {
    return `UUID("${new UUID(Buffer.from(value.buffer)).toString()}")`;
  }
  if (value instanceof Date) return `ISODate("${value.toISOString()}")`;
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}
