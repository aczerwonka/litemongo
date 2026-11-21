import type { Db, Document, Sort } from 'mongodb';
import { EJSON, ObjectId } from '../lib/bson.js';
import { getPathValues, isPlainObject, toMongoPath, typedKey } from '../lib/paths.js';
import { PLACEHOLDER, RECIPE_LIMITS, type Recipe, type RecipeParam, type RecipeStep, type RecipeStrategy } from '../lib/recipe.js';
import { ensureProjected } from './batcher.js';

/**
 * Executes a fetch recipe (see lib/recipe.ts): the root step's find(), then each
 * child step with its own algorithm. Only find() is ever issued, so a recipe is
 * read-only by construction.
 */

/** The one database call a recipe needs; a fake implements it in unit tests. */
export interface RecipeDb {
  find(collection: string, filter: Document, options: { projection?: Document; sort?: Sort; limit: number }): Promise<Document[]>;
}

export function recipeDb(db: Db, maxTimeMS = 15_000): RecipeDb {
  return {
    find: (collection, filter, { projection, sort, limit }) =>
      db
        .collection(collection)
        .find(filter, {
          ...(projection && Object.keys(projection).length > 0 ? { projection } : {}),
          ...(sort && Object.keys(sort as object).length > 0 ? { sort } : {}),
          limit,
          maxTimeMS,
        })
        .toArray(),
  };
}

export interface RecipeNode {
  step: string;
  collection: string;
  doc: Document;
  /** Child nodes keyed by child step id. */
  children: Record<string, RecipeNode[]>;
}

export interface RecipeStepStats {
  step: string;
  collection: string;
  strategy: RecipeStrategy | 'root';
  parent: string | null;
  queries: number;
  /** Unique parent keys (in / batched) or parents queried (nested-loop). */
  keys: number;
  docs: number;
  truncated: boolean;
  /** nested-loop: parents not queried (over maxParents, or no key). */
  skippedParents: number;
  ms: number;
}

export interface RecipeTraceEntry {
  step: string;
  collection: string;
  strategy: RecipeStrategy | 'root';
  /** "find", "batch 2/5", "parent 3/40". */
  label: string;
  /** Start, ms since the run began. */
  start: number;
  ms: number;
  docs: number;
  keys?: number;
}

export interface RecipeResult {
  recipeId: string;
  roots: RecipeNode[];
  steps: RecipeStepStats[];
  trace: RecipeTraceEntry[];
  traceTruncated: boolean;
  warnings: string[];
  queries: number;
  totalMs: number;
}

export interface RecipeRunOptions {
  /** Parameter values as typed in the form. */
  params?: Record<string, unknown>;
  /** Hard cap on queries per run (protects the jump host). */
  maxQueries?: number;
}

export const MAX_RECIPE_QUERIES = 2_000;
const MAX_TRACE = 1_000;

export class RecipeInputError extends Error {}

// --- placeholders ------------------------------------------------------------

/** A placeholder with no value: the key (or array element) holding it is dropped. */
const OMIT = Symbol('omit');
/** A parent value is missing: the nested-loop query for that parent is skipped. */
class MissingParentValue extends Error {}

type Lookup = (name: string) => unknown;

function resolve(value: unknown, lookup: Lookup): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
    if (whole) {
      // Raw Extended JSON in, so the typed value goes back in as Extended JSON.
      const v = lookup(whole[1] as string);
      return v === OMIT ? OMIT : EJSON.serialize(v, { relaxed: false });
    }
    if (!value.includes('{{')) return value;
    let omitted = false;
    const text = value.replace(PLACEHOLDER, (_, name: string) => {
      const v = lookup(name);
      if (v === OMIT) {
        omitted = true;
        return '';
      }
      return v instanceof ObjectId ? v.toHexString() : v instanceof Date ? v.toISOString() : String(v);
    });
    return omitted ? OMIT : text;
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, lookup)).filter((v) => v !== OMIT);
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    const out: Document = {};
    for (const [k, v] of entries) {
      const r = resolve(v, lookup);
      if (r !== OMIT) out[k] = r;
    }
    return entries.length > 0 && Object.keys(out).length === 0 ? OMIT : out;
  }
  return value;
}

/**
 * Fill the placeholders of a raw Extended JSON fragment, then deserialize it.
 * Substitution must come first: EJSON would turn `{ $regex: "^{{q}}" }` into a
 * regex object (and `{ $oid: … }` into an ObjectId) before the text is filled.
 */
function build(raw: Record<string, unknown> | undefined, where: string, lookup: Lookup): Document {
  if (!raw) return {};
  const r = resolve(raw, lookup);
  return r === OMIT ? {} : (deserialize(r as Record<string, unknown>, where) as Document);
}

/** Form text → BSON value per declared type; empty optional → OMIT. */
export function convertParams(defs: RecipeParam[] = [], raw: Record<string, unknown> = {}): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const def of defs) {
    const given = raw[def.name] ?? def.default;
    const text = given === undefined || given === null ? '' : String(given).trim();
    const label = def.label ?? def.name;
    if (text === '') {
      if (def.required) throw new RecipeInputError(`Parameter "${label}" is required`);
      out.set(def.name, OMIT);
      continue;
    }
    switch (def.type ?? 'string') {
      case 'number': {
        const n = Number(text);
        if (!Number.isFinite(n)) throw new RecipeInputError(`Parameter "${label}" must be a number`);
        out.set(def.name, n);
        break;
      }
      case 'objectId':
        if (!ObjectId.isValid(text) || text.length !== 24) throw new RecipeInputError(`Parameter "${label}" must be a 24-hex ObjectId`);
        out.set(def.name, new ObjectId(text));
        break;
      case 'date': {
        const d = new Date(text);
        if (Number.isNaN(d.getTime())) throw new RecipeInputError(`Parameter "${label}" must be a date (e.g. 2026-01-31)`);
        out.set(def.name, d);
        break;
      }
      case 'boolean':
        if (!['true', 'false'].includes(text)) throw new RecipeInputError(`Parameter "${label}" must be true or false`);
        out.set(def.name, text === 'true');
        break;
      case 'json':
        try {
          out.set(def.name, EJSON.parse(text, { relaxed: false }));
        } catch (err) {
          throw new RecipeInputError(`Parameter "${label}" is not valid Extended JSON: ${(err as Error).message}`);
        }
        break;
      default:
        out.set(def.name, text);
    }
  }
  return out;
}

function deserialize(doc: Record<string, unknown> | undefined, where: string): Document | undefined {
  if (!doc) return undefined;
  try {
    return EJSON.deserialize(doc, { relaxed: false }) as Document;
  } catch (err) {
    throw new RecipeInputError(`${where} is not valid Extended JSON: ${(err as Error).message}`);
  }
}

// --- execution ---------------------------------------------------------------

function uniqueValues(docs: Document[], path: string): unknown[] {
  const seen = new Map<string, unknown>();
  for (const doc of docs) {
    for (const value of getPathValues(doc, path)) {
      const key = typedKey(value);
      if (key !== undefined && !seen.has(key)) seen.set(key, value);
    }
  }
  return [...seen.values()];
}

async function pool<T>(items: T[], concurrency: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await work(items[i] as T, i);
    }
  });
  await Promise.all(runners);
}

export async function runRecipe(db: RecipeDb, recipe: Recipe, options: RecipeRunOptions = {}): Promise<RecipeResult> {
  const started = performance.now();
  const params = convertParams(recipe.params, options.params);
  const maxQueries = options.maxQueries ?? MAX_RECIPE_QUERIES;
  const paramLookup: Lookup = (name) => {
    if (!params.has(name)) throw new RecipeInputError(`Unknown parameter "{{${name}}}"`);
    return params.get(name);
  };

  const trace: RecipeTraceEntry[] = [];
  const warnings: string[] = [];
  let traceTruncated = false;
  let queries = 0;
  let budgetWarned = false;

  /** One find() with tracing and the global query budget; null when over budget. */
  const query = async (
    step: RecipeStep,
    strategy: RecipeTraceEntry['strategy'],
    label: string,
    filter: Document,
    opts: { projection?: Document | undefined; sort?: Sort | undefined; limit: number },
    keys?: number,
  ): Promise<Document[] | null> => {
    if (queries >= maxQueries) {
      if (!budgetWarned) warnings.push(`Query budget of ${maxQueries} reached; remaining queries were skipped`);
      budgetWarned = true;
      return null;
    }
    queries += 1;
    const t0 = performance.now();
    const docs = await db.find(step.collection, filter, {
      ...(opts.projection ? { projection: opts.projection } : {}),
      ...(opts.sort ? { sort: opts.sort } : {}),
      limit: opts.limit,
    });
    if (trace.length < MAX_TRACE) {
      trace.push({
        step: step.id,
        collection: step.collection,
        strategy,
        label,
        start: Math.round(t0 - started),
        ms: Math.round(performance.now() - t0),
        docs: docs.length,
        ...(keys !== undefined ? { keys } : {}),
      });
    } else traceTruncated = true;
    return docs;
  };

  /** Projection for a step, widened to keep the keys its children (and its own join) read. */
  const projectionFor = (step: RecipeStep): Document | undefined => {
    let projection = deserialize(step.projection, `steps.${step.id}.projection`);
    if (step.foreignField) projection = ensureProjected(projection, step.foreignField);
    for (const child of recipe.steps) {
      if (child.parent !== step.id) continue;
      if (child.localField) projection = ensureProjected(projection, child.localField);
      for (const name of placeholdersOf(child.filter)) {
        if (name.startsWith('parent.')) projection = ensureProjected(projection, name.slice('parent.'.length));
      }
    }
    return projection;
  };

  const nodesByStep = new Map<string, RecipeNode[]>();
  const stats: RecipeStepStats[] = [];

  // Root.
  const [rootStep, ...childSteps] = recipe.steps as [RecipeStep, ...RecipeStep[]];
  const rootStart = performance.now();
  const rootFilter = build(rootStep.filter, `steps.${rootStep.id}.filter`, paramLookup);
  const rootLimit = Math.min(rootStep.limit ?? RECIPE_LIMITS.rootLimit.fallback, RECIPE_LIMITS.rootLimit.max);
  const rootDocs =
    (await query(rootStep, 'root', 'find', rootFilter, {
      projection: projectionFor(rootStep),
      sort: deserialize(rootStep.sort, `steps.${rootStep.id}.sort`) as Sort | undefined,
      limit: rootLimit + 1,
    })) ?? [];
  const rootTruncated = rootDocs.length > rootLimit;
  if (rootTruncated) rootDocs.length = rootLimit;
  const roots: RecipeNode[] = rootDocs.map((doc) => ({ step: rootStep.id, collection: rootStep.collection, doc, children: {} }));
  nodesByStep.set(rootStep.id, roots);
  stats.push({
    step: rootStep.id,
    collection: rootStep.collection,
    strategy: 'root',
    parent: null,
    queries: 1,
    keys: 0,
    docs: roots.length,
    truncated: rootTruncated,
    skippedParents: 0,
    ms: Math.round(performance.now() - rootStart),
  });

  for (const step of childSteps) {
    const stepStart = performance.now();
    const queriesBefore = queries;
    const parents = nodesByStep.get(step.parent as string) ?? [];
    const strategy = step.strategy ?? 'in';
    const projection = projectionFor(step);
    const sort = deserialize(step.sort, `steps.${step.id}.sort`) as Sort | undefined;
    const rawFilter = step.filter;
    const filterWhere = `steps.${step.id}.filter`;
    const nodes: RecipeNode[] = [];
    let truncated = false;
    let keys = 0;
    let skippedParents = 0;
    let docCount = 0;

    if (strategy === 'nested-loop') {
      const perParent = Math.min(step.limit ?? RECIPE_LIMITS.perParentLimit.fallback, RECIPE_LIMITS.perParentLimit.max);
      const maxParents = step.maxParents ?? RECIPE_LIMITS.maxParents.fallback;
      const queried = parents.slice(0, maxParents);
      skippedParents = parents.length - queried.length;
      if (skippedParents > 0) warnings.push(`${step.id}: only the first ${maxParents} of ${parents.length} parents were queried (maxParents)`);
      for (const parent of parents) parent.children[step.id] = [];
      await pool(queried, step.concurrency ?? RECIPE_LIMITS.concurrency.fallback, async (parent, i) => {
        let filter: Document;
        try {
          filter = build(rawFilter, filterWhere, (name) => {
            if (!name.startsWith('parent.')) return paramLookup(name);
            const values = getPathValues(parent.doc, name.slice('parent.'.length));
            if (values.length === 0) throw new MissingParentValue();
            return values.length === 1 ? values[0] : { $in: values };
          });
          if (step.localField && step.foreignField) {
            const values = getPathValues(parent.doc, step.localField);
            if (values.length === 0) throw new MissingParentValue();
            const condition = { [toMongoPath(step.foreignField)]: values.length === 1 ? values[0] : { $in: values } };
            filter = Object.keys(filter).length > 0 ? { $and: [condition, filter] } : condition;
          }
        } catch (err) {
          if (err instanceof MissingParentValue) {
            skippedParents += 1;
            return;
          }
          throw err;
        }
        keys += 1;
        const docs = await query(step, strategy, `parent ${i + 1}/${queried.length}`, filter, { projection, sort, limit: perParent + 1 });
        if (!docs) return;
        if (docs.length > perParent) {
          truncated = true;
          docs.length = perParent;
        }
        docCount += docs.length;
        const list = docs.map((doc) => ({ step: step.id, collection: step.collection, doc, children: {} }));
        parent.children[step.id] = list;
        nodes.push(...list);
      });
    } else {
      const localField = step.localField as string;
      const foreignField = step.foreignField as string;
      const foreignPath = toMongoPath(foreignField);
      const extra = build(rawFilter, filterWhere, paramLookup);
      const keyValues = uniqueValues(
        parents.map((p) => p.doc),
        localField,
      );
      keys = keyValues.length;
      const cap = Math.min(step.limit ?? RECIPE_LIMITS.stepLimit.fallback, RECIPE_LIMITS.stepLimit.max);
      const batchSize = strategy === 'batched' ? (step.batchSize ?? RECIPE_LIMITS.batchSize.fallback) : Math.max(keyValues.length, 1);
      const batches: unknown[][] = [];
      for (let i = 0; i < keyValues.length; i += batchSize) batches.push(keyValues.slice(i, i + batchSize));
      const fetched: Document[][] = [];
      let total = 0;
      const concurrency = strategy === 'batched' ? (step.concurrency ?? 1) : 1;
      await pool(batches, concurrency, async (batch, i) => {
        if (total > cap) return; // cap already exceeded by earlier packets
        const condition = { [foreignPath]: { $in: batch } };
        const filter = Object.keys(extra).length > 0 ? { $and: [condition, extra] } : condition;
        const label = strategy === 'batched' ? `batch ${i + 1}/${batches.length}` : '$in';
        const docs = await query(step, strategy, label, filter, { projection, sort, limit: cap - total + 1 }, batch.length);
        if (!docs) return;
        fetched[i] = docs;
        total += docs.length;
      });
      let childDocs = fetched.flatMap((d) => d ?? []);
      if (childDocs.length > cap) {
        truncated = true;
        childDocs = childDocs.slice(0, cap);
      }
      docCount = childDocs.length;

      const byKey = new Map<string, Document[]>();
      for (const child of childDocs) {
        for (const value of getPathValues(child, foreignField)) {
          const key = typedKey(value);
          if (key === undefined) continue;
          const bucket = byKey.get(key);
          if (bucket) bucket.push(child);
          else byKey.set(key, [child]);
        }
      }
      const nodeByDoc = new Map<Document, RecipeNode>();
      for (const parent of parents) {
        const attached = new Set<Document>();
        const list: RecipeNode[] = [];
        for (const value of getPathValues(parent.doc, localField)) {
          const key = typedKey(value);
          if (key === undefined) continue;
          for (const child of byKey.get(key) ?? []) {
            if (attached.has(child)) continue;
            attached.add(child);
            let node = nodeByDoc.get(child);
            if (!node) {
              node = { step: step.id, collection: step.collection, doc: child, children: {} };
              nodeByDoc.set(child, node);
              nodes.push(node);
            }
            list.push(node);
          }
        }
        parent.children[step.id] = list;
      }
    }

    nodesByStep.set(step.id, nodes);
    stats.push({
      step: step.id,
      collection: step.collection,
      strategy,
      parent: step.parent ?? null,
      queries: queries - queriesBefore,
      keys,
      docs: docCount,
      truncated,
      skippedParents,
      ms: Math.round(performance.now() - stepStart),
    });
  }

  trace.sort((a, b) => a.start - b.start);
  return {
    recipeId: recipe.id,
    roots,
    steps: stats,
    trace,
    traceTruncated,
    warnings,
    queries,
    totalMs: Math.round(performance.now() - started),
  };
}

function placeholdersOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') for (const m of value.matchAll(PLACEHOLDER)) out.push(m[1] as string);
  else if (Array.isArray(value)) value.forEach((v) => placeholdersOf(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => placeholdersOf(v, out));
  return out;
}
