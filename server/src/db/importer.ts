import { randomUUID } from 'node:crypto';
import { Binary, Double, EJSON, Int32, Long, ObjectId, UUID } from '../lib/bson.js';
import type { Db, Document } from 'mongodb';
import type { CollectionSchema, RenumberRule, RenumberingRules } from '../lib/config.js';
import { bsonTypeName, displayValue, getPathValues, isPlainObject, toMongoPath, typedKey } from '../lib/paths.js';

/**
 * Two-Pass Deterministic Graph Remapper for EJSON transfer bundles.
 *
 * Pass 1 — Graph indexing: visit every configured id path (`schemas[c].idPaths`,
 *   always including `_id`) of every document and allocate a NEW value of the
 *   SAME BSON type for each distinct old value: Map<typedKey(old), new>.
 * Pass 2 — Reference rewriting: walk every value of every document. A value is
 *   replaced only if its exact typed identity is in the map, and never under a
 *   `protectedCodePaths` subtree (domain codes such as `covers[].loadings[].code`).
 *   This rewrites root ids, nested array ids and soft foreign keys
 *   (`policyId`, `claimId`, `coverId`, ...) consistently across collections.
 *
 * "Deterministic": within one run, the same old id always maps to the same new id,
 * so every reference to it stays connected.
 */

export const BUNDLE_FORMAT = 'litemongo-bundle';
export const MAX_BUNDLE_DOCUMENTS = 50_000;
const PREVIEW_LIST_LIMIT = 1_000;

export interface TransferBundle {
  format: typeof BUNDLE_FORMAT;
  version: 1;
  sourceDb?: string;
  exportedAt?: string;
  blueprintId?: string;
  /** Insertion order follows key order (root collection first). */
  collections: Record<string, Document[]>;
}

export interface RemapOptions {
  schemas: Record<string, CollectionSchema>;
  renumberingRules: RenumberingRules;
  /** Injectable clock for reproducible tests. */
  now?: Date;
}

export interface IdMapping {
  collection: string;
  path: string;
  type: string;
  old: string;
  new: string;
}

export interface RewrittenLink {
  collection: string;
  documentId: string;
  path: string;
  old: string;
  new: string;
  /** Where the referenced id was defined, e.g. "policies._id". */
  references: string;
  /** False when the path is not declared in schemas[c].foreignKeys — review these. */
  declared: boolean;
}

export interface CollectionRemapSummary {
  documents: number;
  rootIdsRemapped: number;
  nestedIdsRemapped: number;
  foreignKeysRewritten: number;
}

export interface RemapSummary {
  remapped: boolean;
  totals: CollectionRemapSummary;
  collections: Record<string, CollectionRemapSummary>;
  idMap: IdMapping[];
  links: RewrittenLink[];
  truncatedLists: boolean;
  warnings: string[];
}

export interface RemapResult {
  bundle: TransferBundle;
  summary: RemapSummary;
}

// ---------------------------------------------------------------------------
// Bundle (de)serialization — canonical EJSON keeps ObjectId, Decimal128, Date,
// Long, Int32, Double and UUID exact across the clipboard.
// ---------------------------------------------------------------------------

export function serializeBundle(bundle: TransferBundle): string {
  return EJSON.stringify(bundle, undefined, 2, { relaxed: false });
}

export function parseBundle(text: string): TransferBundle {
  let parsed: unknown;
  try {
    parsed = EJSON.parse(text, { relaxed: false });
  } catch (err) {
    throw new Error(`Bundle is not valid Extended JSON: ${(err as Error).message}`);
  }
  return validateBundle(parsed);
}

export function validateBundle(value: unknown): TransferBundle {
  if (!isPlainObject(value)) throw new Error('Bundle must be a JSON object');
  if (value.format !== BUNDLE_FORMAT) throw new Error(`Bundle "format" must be "${BUNDLE_FORMAT}"`);
  if (!isPlainObject(value.collections)) throw new Error('Bundle "collections" must be an object');
  let total = 0;
  for (const [name, docs] of Object.entries(value.collections)) {
    if (!name || name.includes('$') || name.startsWith('system.')) {
      throw new Error(`Bundle contains an invalid collection name: "${name}"`);
    }
    if (!Array.isArray(docs) || !docs.every(isPlainObject)) {
      throw new Error(`Bundle collection "${name}" must be an array of documents`);
    }
    total += docs.length;
  }
  if (total > MAX_BUNDLE_DOCUMENTS) {
    throw new Error(`Bundle has ${total} documents; the limit is ${MAX_BUNDLE_DOCUMENTS}`);
  }
  return value as unknown as TransferBundle;
}

export function buildBundle(
  collections: Record<string, Document[]>,
  meta: { sourceDb?: string; blueprintId?: string } = {},
): TransferBundle {
  return {
    format: BUNDLE_FORMAT,
    version: 1,
    ...(meta.sourceDb ? { sourceDb: meta.sourceDb } : {}),
    exportedAt: new Date().toISOString(),
    ...(meta.blueprintId ? { blueprintId: meta.blueprintId } : {}),
    collections,
  };
}

// ---------------------------------------------------------------------------
// Pass 1 helpers — new id generation preserving the original BSON type
// ---------------------------------------------------------------------------

interface MapEntry {
  oldValue: unknown;
  newValue: unknown;
  collection: string;
  path: string;
}

function findRule(rules: RenumberingRules, collection: string, path: string): RenumberRule | undefined {
  const byCollection = rules[collection];
  if (!byCollection) return undefined;
  if (byCollection[path]) return byCollection[path];
  const dotted = toMongoPath(path);
  return Object.entries(byCollection).find(([p]) => toMongoPath(p) === dotted)?.[1];
}

function timestampStamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

class IdGenerator {
  private readonly stamp: string;
  private readonly runToken: string;
  private sequence = 0;
  private readonly issuedStrings = new Set<string>();

  constructor(now: Date) {
    this.stamp = timestampStamp(now);
    this.runToken = now.getTime().toString(36).toUpperCase();
  }

  private uniqueString(make: () => string): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = make();
      if (!this.issuedStrings.has(candidate)) {
        this.issuedStrings.add(candidate);
        return candidate;
      }
    }
    throw new Error('Could not generate a unique string id');
  }

  /** Returns the new value, or a string explaining why the id is left unchanged. */
  generate(value: unknown, rule: RenumberRule | undefined): { value: unknown } | { skip: string } {
    if (rule?.strategy === 'KEEP') return { skip: '' };

    if (value instanceof ObjectId) return { value: new ObjectId() };
    if (value instanceof Binary && value.sub_type === Binary.SUBTYPE_UUID) return { value: new UUID() };

    if (typeof value === 'string') {
      const prefix = rule?.prefix ?? '';
      switch (rule?.strategy) {
        case 'SUFFIX_TIMESTAMP':
          return {
            value: this.uniqueString(() => `${prefix}${this.stamp}-${String(++this.sequence).padStart(3, '0')}`),
          };
        case 'UUID_SHORT':
          return {
            value: this.uniqueString(() => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`),
          };
        case 'OFFSET':
          return { skip: 'OFFSET applies to numeric ids only' };
        default:
          // No rule: keep the original readable shape and append a run token.
          return { value: this.uniqueString(() => `${value}-${this.runToken}`) };
      }
    }

    if (rule?.strategy === 'OFFSET' && typeof rule.offset === 'number') {
      const offset = rule.offset;
      if (value instanceof Int32) {
        const next = value.value + offset;
        if (!Number.isInteger(next) || next > 2_147_483_647 || next < -2_147_483_648) {
          return { skip: 'Int32 overflow after OFFSET' };
        }
        return { value: new Int32(next) };
      }
      if (value instanceof Long) return { value: value.add(Long.fromNumber(offset)) };
      if (value instanceof Double) return { value: new Double(value.value + offset) };
      if (typeof value === 'number') return { value: value + offset };
    }

    if (value instanceof Int32 || value instanceof Long || value instanceof Double || typeof value === 'number') {
      return { skip: 'numeric ids need an OFFSET renumbering rule' };
    }
    return { skip: `unsupported id type ${bsonTypeName(value)}` };
  }
}

// ---------------------------------------------------------------------------
// The remapper
// ---------------------------------------------------------------------------

function idPathsFor(schema: CollectionSchema | undefined): string[] {
  const paths = schema?.idPaths ?? [];
  return paths.some((p) => toMongoPath(p) === '_id') ? paths : ['_id', ...paths];
}

function documentLabel(doc: Document): string {
  return doc._id === undefined ? '(no _id)' : displayValue(doc._id);
}

function emptySummary(documents = 0): CollectionRemapSummary {
  return { documents, rootIdsRemapped: 0, nestedIdsRemapped: 0, foreignKeysRewritten: 0 };
}

export function remapBundle(input: TransferBundle, options: RemapOptions): RemapResult {
  const { schemas, renumberingRules } = options;
  const generator = new IdGenerator(options.now ?? new Date());
  const idMap = new Map<string, MapEntry>();
  const warnings: string[] = [];
  const mappings: IdMapping[] = [];
  const links: RewrittenLink[] = [];
  let truncatedLists = false;

  // ---------------- Pass 1: index ids & allocate new typed values ----------------
  for (const [collection, docs] of Object.entries(input.collections)) {
    for (const path of idPathsFor(schemas[collection])) {
      const rule = findRule(renumberingRules, collection, path);
      const skipped = new Map<string, number>();
      for (const doc of docs) {
        for (const value of getPathValues(doc, path)) {
          const key = typedKey(value);
          if (key === undefined || idMap.has(key)) continue;
          const result = generator.generate(value, rule);
          if ('skip' in result) {
            if (result.skip) skipped.set(result.skip, (skipped.get(result.skip) ?? 0) + 1);
            continue;
          }
          idMap.set(key, { oldValue: value, newValue: result.value, collection, path });
          if (mappings.length < PREVIEW_LIST_LIMIT) {
            mappings.push({
              collection,
              path,
              type: bsonTypeName(value),
              old: displayValue(value),
              new: displayValue(result.value),
            });
          } else truncatedLists = true;
        }
      }
      for (const [reason, count] of skipped) {
        warnings.push(`${collection}.${path}: ${count} id(s) left unchanged (${reason}).`);
      }
    }
  }

  // ---------------- Pass 2: context-aware reference rewriting ----------------
  const summaries: Record<string, CollectionRemapSummary> = {};
  const outCollections: Record<string, Document[]> = {};

  for (const [collection, docs] of Object.entries(input.collections)) {
    const schema = schemas[collection];
    const protectedPaths = new Set((schema?.protectedCodePaths ?? []).map(toMongoPath));
    const idPaths = new Set(idPathsFor(schema).map(toMongoPath));
    const declaredFks = new Set(Object.keys(schema?.foreignKeys ?? {}).map(toMongoPath));
    const summary = emptySummary(docs.length);
    summaries[collection] = summary;

    const isProtected = (path: string): boolean => {
      for (const p of protectedPaths) {
        if (path === p || path.startsWith(`${p}.`)) return true;
      }
      return false;
    };

    outCollections[collection] = docs.map((doc) => {
      const label = documentLabel(doc);
      const walk = (node: unknown, path: string): unknown => {
        if (path && isProtected(path)) return node;
        if (Array.isArray(node)) return node.map((item) => walk(item, path));
        if (isPlainObject(node)) {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(node)) out[k] = walk(v, path ? `${path}.${k}` : k);
          return out;
        }
        const key = typedKey(node);
        const entry = key === undefined ? undefined : idMap.get(key);
        if (!entry) return node;

        if (path === '_id') summary.rootIdsRemapped += 1;
        else if (idPaths.has(path)) summary.nestedIdsRemapped += 1;
        else {
          summary.foreignKeysRewritten += 1;
          if (links.length < PREVIEW_LIST_LIMIT) {
            links.push({
              collection,
              documentId: label,
              path,
              old: displayValue(entry.oldValue),
              new: displayValue(entry.newValue),
              references: `${entry.collection}.${entry.path}`,
              declared: declaredFks.has(path),
            });
          } else truncatedLists = true;
        }
        return entry.newValue;
      };
      return walk(doc, '') as Document;
    });

    // Dangling references: declared FK values that point outside the bundle.
    for (const fkPath of Object.keys(schema?.foreignKeys ?? {})) {
      let dangling = 0;
      for (const doc of docs) {
        for (const value of getPathValues(doc, fkPath)) {
          const key = typedKey(value);
          if (key !== undefined && !idMap.has(key)) dangling += 1;
        }
      }
      if (dangling > 0) {
        warnings.push(
          `${collection}.${fkPath}: ${dangling} reference(s) point to ids not in this bundle and were left unchanged.`,
        );
      }
    }
  }

  const totals = Object.values(summaries).reduce((acc, s) => {
    acc.documents += s.documents;
    acc.rootIdsRemapped += s.rootIdsRemapped;
    acc.nestedIdsRemapped += s.nestedIdsRemapped;
    acc.foreignKeysRewritten += s.foreignKeysRewritten;
    return acc;
  }, emptySummary());

  return {
    bundle: { ...input, collections: outCollections },
    summary: {
      remapped: true,
      totals,
      collections: summaries,
      idMap: mappings,
      links,
      truncatedLists,
      warnings,
    },
  };
}

/** Summary for a paste without remapping (ids inserted as-is). */
export function identitySummary(bundle: TransferBundle): RemapSummary {
  const collections: Record<string, CollectionRemapSummary> = {};
  let documents = 0;
  for (const [name, docs] of Object.entries(bundle.collections)) {
    collections[name] = emptySummary(docs.length);
    documents += docs.length;
  }
  return {
    remapped: false,
    totals: emptySummary(documents),
    collections,
    idMap: [],
    links: [],
    truncatedLists: false,
    warnings: ['IDs are not remapped: documents whose _id already exists in the target will fail.'],
  };
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

export interface PasteCollectionResult {
  inserted: number;
  failed: number;
  errors: string[];
}

export interface PasteResult {
  targetDb: string;
  collections: Record<string, PasteCollectionResult>;
  inserted: number;
  failed: number;
}

interface WriteErrorLike {
  code?: number;
  errmsg?: string;
  message?: string;
}

export async function insertBundle(db: Db, bundle: TransferBundle): Promise<PasteResult> {
  const result: PasteResult = { targetDb: db.databaseName, collections: {}, inserted: 0, failed: 0 };
  for (const [name, docs] of Object.entries(bundle.collections)) {
    const entry: PasteCollectionResult = { inserted: 0, failed: 0, errors: [] };
    result.collections[name] = entry;
    if (docs.length === 0) continue;
    try {
      const res = await db.collection(name).insertMany(docs, { ordered: false });
      entry.inserted = res.insertedCount;
    } catch (err) {
      // MongoBulkWriteError: partial success with per-document errors.
      const bulk = err as { insertedCount?: number; writeErrors?: WriteErrorLike[] | WriteErrorLike; message?: string };
      const writeErrors = bulk.writeErrors
        ? Array.isArray(bulk.writeErrors)
          ? bulk.writeErrors
          : [bulk.writeErrors]
        : [];
      if (writeErrors.length === 0) throw err;
      entry.inserted = bulk.insertedCount ?? 0;
      entry.failed = writeErrors.length;
      entry.errors = writeErrors.slice(0, 10).map((e) => {
        const msg = e.errmsg ?? e.message ?? 'write error';
        return e.code === 11000 ? `Duplicate key: ${msg}` : msg;
      });
    }
    result.inserted += entry.inserted;
    result.failed += entry.failed;
  }
  return result;
}
