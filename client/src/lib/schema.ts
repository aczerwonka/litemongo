import type { CollectionSchema } from '../types';
import { classify } from './ejson';

/**
 * Field-tree model behind `schemas[collection].coreFields` in litemongo.config.json.
 *
 * A field is documented by a `FieldDef`; arrays of sub-documents nest their item
 * fields under `items`, embedded objects under `fields`. Paths into the tree are
 * written as name segments (`['covers', 'loadings', 'code']`); the config-style
 * path marks arrays with `[]` (`covers[].loadings[].code`).
 */

export interface FieldDef {
  type?: string;
  description?: string;
  enum?: string[];
  displayBadgeField?: string;
  /** Fields of the array's items (type: "array"). */
  items?: FieldMap;
  /** Fields of an embedded object (type: "object"). */
  fields?: FieldMap;
}

export type FieldMap = Record<string, FieldDef>;

export const FIELD_TYPES = [
  'string',
  'ObjectId',
  'Date',
  'Decimal128',
  'Int32',
  'Long',
  'Double',
  'boolean',
  'UUID',
  'object',
  'array',
  'mixed',
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isMap(v: unknown): v is FieldMap {
  return isRecord(v);
}

export function fieldMapOf(schema: CollectionSchema | undefined): FieldMap {
  return isRecord(schema?.coreFields) ? (schema.coreFields as FieldMap) : {};
}

/** Nested field map of a container field, if it documents one. */
export function childMap(def: FieldDef | undefined): FieldMap | undefined {
  if (!isRecord(def)) return undefined;
  if (isMap(def.items)) return def.items;
  if (isMap(def.fields)) return def.fields;
  return undefined;
}

/** Field map documenting the objects found at `path` (name segments, no indices). */
export function fieldMapAt(schema: CollectionSchema | undefined, path: string[]): FieldMap | undefined {
  let map: FieldMap | undefined = fieldMapOf(schema);
  for (const segment of path) {
    map = childMap(map?.[segment]);
    if (!map) return undefined;
  }
  return map;
}

export interface FlatField {
  /** Name segments from the root. */
  key: string[];
  /** Config-style path with `[]` after arrays, e.g. `covers[].loadings[].code`. */
  configPath: string;
  /** MongoDB dotted path, e.g. `covers.loadings.code`. */
  mongoPath: string;
  /** 1 for top-level fields, +1 per enclosing array/object. */
  level: number;
  def: FieldDef;
}

/** Config-style path for name segments, given which ancestors are arrays. */
function joinConfigPath(parent: string, parentIsArray: boolean, name: string): string {
  if (!parent) return name;
  return `${parent}${parentIsArray ? '[]' : ''}.${name}`;
}

/** Depth-first list of every documented field. */
export function flattenFields(map: FieldMap): FlatField[] {
  const out: FlatField[] = [];
  const walk = (fields: FieldMap, key: string[], parentPath: string, parentIsArray: boolean) => {
    for (const [name, raw] of Object.entries(fields)) {
      const def: FieldDef = isRecord(raw) ? raw : {};
      const configPath = joinConfigPath(parentPath, parentIsArray, name);
      const fieldKey = [...key, name];
      out.push({ key: fieldKey, configPath, mongoPath: fieldKey.join('.'), level: fieldKey.length, def });
      const children = childMap(def);
      if (children) walk(children, fieldKey, configPath, isRecord(def.items) || def.type === 'array');
    }
  };
  walk(map, [], '', false);
  return out;
}

// ---------------------------------------------------------------------------
// Inference from sample documents
// ---------------------------------------------------------------------------

export interface InferResult {
  fields: FieldMap;
  /** configPath -> share (0..1) of parent objects that carry the field. */
  coverage: Record<string, number>;
}

function typeName(v: unknown): string {
  const t = classify(v).type;
  if (t === 'bool') return 'boolean';
  if (t === 'number') return 'Double';
  return t;
}

/** Derive a field tree (types, nesting) and per-field coverage from canonical-EJSON documents. */
export function inferFields(docs: unknown[]): InferResult {
  const seen = new Map<string, number>();
  const parents = new Map<string, number>();

  const visit = (objects: Record<string, unknown>[], parentPath: string, parentIsArray: boolean): FieldMap => {
    const map: FieldMap = {};
    const values = new Map<string, unknown[]>();
    for (const obj of objects) {
      for (const [k, v] of Object.entries(obj)) {
        const list = values.get(k);
        if (list) list.push(v);
        else values.set(k, [v]);
      }
    }
    for (const [name, list] of values) {
      const configPath = joinConfigPath(parentPath, parentIsArray, name);
      seen.set(configPath, list.length);
      parents.set(configPath, objects.length);
      const types = new Set(list.filter((v) => v !== null).map(typeName));
      const def: FieldDef = {};
      if (types.size === 1) def.type = [...types][0] as string;
      else if (types.size > 1) def.type = 'mixed';
      if (def.type === 'array') {
        const items = list.flatMap((v) => (Array.isArray(v) ? v : [])).filter((v) => classify(v).kind === 'object');
        if (items.length > 0) def.items = visit(items as Record<string, unknown>[], configPath, true);
      } else if (def.type === 'object') {
        const objs = list.filter((v) => classify(v).kind === 'object') as Record<string, unknown>[];
        def.fields = visit(objs, configPath, false);
      }
      map[name] = def;
    }
    return map;
  };

  const roots = docs.filter((d) => classify(d).kind === 'object') as Record<string, unknown>[];
  const fields = visit(roots, '', false);
  const coverage: Record<string, number> = {};
  for (const [path, count] of seen) coverage[path] = count / (parents.get(path) || 1);
  return { fields, coverage };
}

/**
 * Merge inferred fields into a documented tree: new fields are added, missing
 * types filled in; everything the user already documented is kept as is.
 * Returns the merged tree and how many fields were added.
 */
export function mergeFields(existing: FieldMap, inferred: FieldMap): { fields: FieldMap; added: number } {
  let added = 0;
  const merge = (current: FieldMap, incoming: FieldMap): FieldMap => {
    const out: FieldMap = { ...current };
    for (const [name, inc] of Object.entries(incoming)) {
      const cur = out[name];
      if (!isRecord(cur)) {
        out[name] = inc;
        added += 1 + flattenFields(childMap(inc) ?? {}).length;
        continue;
      }
      const next: FieldDef = { ...cur };
      if (!next.type && inc.type) next.type = inc.type;
      if (inc.items) next.items = merge(isMap(cur.items) ? cur.items : {}, inc.items);
      if (inc.fields) next.fields = merge(isMap(cur.fields) ? cur.fields : {}, inc.fields);
      out[name] = next;
    }
    return out;
  };
  return { fields: merge(existing, inferred), added };
}

// ---------------------------------------------------------------------------
// Immutable edits
// ---------------------------------------------------------------------------

/** Container map for children of the field at `parentKey` (created on demand). */
function containerAt(root: FieldMap, parentKey: string[]): FieldMap {
  let map = root;
  for (const segment of parentKey) {
    const def = (map[segment] ??= { type: 'object' });
    if (def.type === 'array' || isRecord(def.items)) map = def.items ??= {};
    else {
      def.type ??= 'object';
      map = def.fields ??= {};
    }
  }
  return map;
}

export function withField(root: FieldMap, parentKey: string[], name: string, def: FieldDef): FieldMap {
  const next = structuredClone(root);
  containerAt(next, parentKey)[name] = def;
  return next;
}

export function withFieldPatch(root: FieldMap, key: string[], patch: Partial<FieldDef>): FieldMap {
  const next = structuredClone(root);
  const name = key[key.length - 1] as string;
  const map = containerAt(next, key.slice(0, -1));
  const def: FieldDef = { ...(map[name] ?? {}) };
  for (const [k, v] of Object.entries(patch) as [keyof FieldDef, unknown][]) {
    const empty = v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) delete def[k];
    else (def as Record<string, unknown>)[k] = v;
  }
  // Switching container kind keeps the documented children.
  if (patch.type === 'array' && def.fields) {
    def.items = def.fields;
    delete def.fields;
  } else if (patch.type === 'object' && def.items) {
    def.fields = def.items;
    delete def.items;
  }
  map[name] = def;
  return next;
}

export function withoutField(root: FieldMap, key: string[]): FieldMap {
  const next = structuredClone(root);
  delete containerAt(next, key.slice(0, -1))[key[key.length - 1] as string];
  return next;
}

/** True when `path` is `prefix` itself or lies underneath it (`covers` covers `covers[].code`). */
export function isUnderPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[].`);
}

/** Schema-documented fields first (in schema order), then whatever else the data carries. */
export function orderFields(observed: string[], documented: FieldMap | undefined): string[] {
  const seen = new Set(observed);
  const known = Object.keys(documented ?? {}).filter((k) => seen.has(k));
  const knownSet = new Set(known);
  const rest = observed.filter((k) => !knownSet.has(k));
  const all = [...known, ...rest];
  return all.includes('_id') ? ['_id', ...all.filter((k) => k !== '_id')] : all;
}
