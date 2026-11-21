/**
 * Fetch recipes ("templates"): a saved, parameterised plan that reaches for
 * documents in several collections, one step after another, each step with an
 * explicit fetch algorithm:
 *
 *   - `in`           one query: { foreignField: { $in: <unique parent keys> } }
 *   - `batched`      the same, but the keys go out in packets of `batchSize`
 *                    (optionally a few packets in parallel) — friendlier to a
 *                    busy jump host than one huge $in
 *   - `nested-loop`  one query per parent document, with its own filter / sort /
 *                    limit — "the latest 3 claims of every policy", which a
 *                    single $in cannot express
 *
 * Recipes live in litemongo.config.json (`recipes`); the server only validates
 * and executes the read-only find() calls they describe.
 */

export type RecipeStrategy = 'in' | 'batched' | 'nested-loop';

export const RECIPE_STRATEGIES: readonly RecipeStrategy[] = ['in', 'batched', 'nested-loop'];

export type RecipeParamType = 'string' | 'number' | 'objectId' | 'date' | 'boolean' | 'json';

export const RECIPE_PARAM_TYPES: readonly RecipeParamType[] = ['string', 'number', 'objectId', 'date', 'boolean', 'json'];

export interface RecipeParam {
  name: string;
  label?: string;
  type?: RecipeParamType;
  /** Pre-filled value (text, as typed in the form). */
  default?: string;
  /** Empty + not required: the filter key that uses it is dropped. */
  required?: boolean;
  /** Suggested values for a dropdown. */
  options?: string[];
}

/** How one step's documents are presented (client only; the server ignores it). */
export interface RecipeStepDisplay {
  /** Field shown as the card title (default: badge field / _id). */
  title?: string;
  subtitle?: string;
  /** Fields listed on the card. Empty: the first few top-level scalars. */
  fields?: string[];
  /** Field rendered as a [code] badge. */
  badge?: string;
  /** cards (default) | table (compact rows) | chips (one line each). */
  layout?: 'cards' | 'table' | 'chips';
}

export interface RecipeStep {
  /** Unique within the recipe; children name it in `parent`. */
  id: string;
  label?: string;
  collection: string;
  /** Step whose documents feed this one. Default: the previous step. Absent on the root (first) step. */
  parent?: string;
  /** Fetch algorithm (child steps). Default `in`. */
  strategy?: RecipeStrategy;
  /** Path on the parent document holding the key(s). */
  localField?: string;
  /** Path on this step's documents matched against the parent key. */
  foreignField?: string;
  /**
   * Extra filter (Extended JSON). `"{{param}}"` is replaced by a parameter value;
   * in `nested-loop` steps `"{{parent.path}}"` is replaced by the parent's value.
   */
  filter?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  /** Root: documents fetched. `in` / `batched`: total cap. `nested-loop`: per parent. */
  limit?: number;
  /** `batched`: keys per query. */
  batchSize?: number;
  /** `batched` / `nested-loop`: queries in flight at once. */
  concurrency?: number;
  /** `nested-loop`: at most this many parents get a query (the rest are skipped). */
  maxParents?: number;
  display?: RecipeStepDisplay;
}

export interface RecipeView {
  /** dossier: one card per root with its details; board: root cards in columns by `groupBy`. */
  mode?: 'dossier' | 'board' | 'trace' | 'json';
  /** Board column field on the root documents. */
  groupBy?: string;
}

export interface Recipe {
  id: string;
  name?: string;
  description?: string;
  params?: RecipeParam[];
  steps: RecipeStep[];
  view?: RecipeView;
}

export const MAX_RECIPE_STEPS = 10;
export const RECIPE_LIMITS = {
  rootLimit: { fallback: 50, max: 1_000 },
  stepLimit: { fallback: 5_000, max: 20_000 },
  perParentLimit: { fallback: 10, max: 1_000 },
  batchSize: { fallback: 100, max: 5_000 },
  concurrency: { fallback: 4, max: 16 },
  maxParents: { fallback: 200, max: 1_000 },
} as const;

/** `{{name}}` or `{{parent.path}}`. */
export const PLACEHOLDER = /\{\{\s*([A-Za-z_$][\w$]*(?:\.[\w$[\]]+)*)\s*\}\}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function placeholdersIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(PLACEHOLDER)) out.add(m[1] as string);
  } else if (Array.isArray(value)) {
    value.forEach((v) => placeholdersIn(v, out));
  } else if (isRecord(value)) {
    Object.values(value).forEach((v) => placeholdersIn(v, out));
  }
  return out;
}

function optInt(raw: unknown, where: string, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new Error(`${where} must be an integer between ${min} and ${max}`);
  }
  return raw;
}

function optString(raw: unknown, where: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new Error(`${where} must be a string`);
  return raw;
}

function optObject(raw: unknown, where: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`${where} must be an object`);
  return raw;
}

/** Structural validation; throws an Error with a JSON-path-like message. */
export function parseRecipe(value: unknown): Recipe {
  if (!isRecord(value)) throw new Error('recipe must be an object');
  const id = typeof value.id === 'string' && value.id ? value.id : 'adhoc';
  if (!Array.isArray(value.steps) || value.steps.length === 0) throw new Error('recipe.steps must be a non-empty array');
  if (value.steps.length > MAX_RECIPE_STEPS) throw new Error(`recipe supports at most ${MAX_RECIPE_STEPS} steps`);

  const params: RecipeParam[] = [];
  if (value.params !== undefined) {
    if (!Array.isArray(value.params)) throw new Error('recipe.params must be an array');
    const names = new Set<string>();
    value.params.forEach((p, i) => {
      const where = `recipe.params[${i}]`;
      if (!isRecord(p) || typeof p.name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(p.name)) {
        throw new Error(`${where}.name must be an identifier`);
      }
      if (p.name === 'parent') throw new Error(`${where}.name "parent" is reserved`);
      if (names.has(p.name)) throw new Error(`${where}.name "${p.name}" is duplicated`);
      names.add(p.name);
      if (p.type !== undefined && !RECIPE_PARAM_TYPES.includes(p.type as RecipeParamType)) {
        throw new Error(`${where}.type must be one of ${RECIPE_PARAM_TYPES.join(', ')}`);
      }
      const label = optString(p.label, `${where}.label`);
      const def = optString(p.default, `${where}.default`);
      if (p.options !== undefined && (!Array.isArray(p.options) || !p.options.every((o) => typeof o === 'string'))) {
        throw new Error(`${where}.options must be an array of strings`);
      }
      params.push({
        name: p.name,
        ...(p.type ? { type: p.type as RecipeParamType } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(def !== undefined ? { default: def } : {}),
        ...(p.required === true ? { required: true } : {}),
        ...(Array.isArray(p.options) ? { options: p.options as string[] } : {}),
      });
    });
  }
  const paramNames = new Set(params.map((p) => p.name));

  const stepIds = new Set<string>();
  const steps = value.steps.map((raw, i): RecipeStep => {
    const where = `recipe.steps[${i}]`;
    if (!isRecord(raw)) throw new Error(`${where} must be an object`);
    if (typeof raw.id !== 'string' || !/^[\w-]+$/.test(raw.id)) throw new Error(`${where}.id must be a word (letters, digits, _ or -)`);
    if (stepIds.has(raw.id)) throw new Error(`${where}.id "${raw.id}" is duplicated`);
    if (typeof raw.collection !== 'string' || !raw.collection) throw new Error(`${where}.collection must be a non-empty string`);
    const filter = optObject(raw.filter, `${where}.filter`);
    const projection = optObject(raw.projection, `${where}.projection`);
    const sort = optObject(raw.sort, `${where}.sort`);
    const display = optObject(raw.display, `${where}.display`) as RecipeStepDisplay | undefined;
    const label = optString(raw.label, `${where}.label`);

    const step: RecipeStep = {
      id: raw.id,
      collection: raw.collection,
      ...(label !== undefined ? { label } : {}),
      ...(filter ? { filter } : {}),
      ...(projection ? { projection } : {}),
      ...(sort ? { sort } : {}),
      ...(display ? { display } : {}),
    };

    if (i === 0) {
      if (raw.parent !== undefined) throw new Error(`${where}: the first step is the root and has no parent`);
      const limit = optInt(raw.limit, `${where}.limit`, 1, RECIPE_LIMITS.rootLimit.max);
      if (limit !== undefined) step.limit = limit;
    } else {
      const parent = raw.parent === undefined ? [...stepIds].pop() : raw.parent;
      if (typeof parent !== 'string' || !stepIds.has(parent)) {
        throw new Error(`${where}.parent must name an earlier step`);
      }
      step.parent = parent;
      const strategy = raw.strategy === undefined ? 'in' : raw.strategy;
      if (!RECIPE_STRATEGIES.includes(strategy as RecipeStrategy)) {
        throw new Error(`${where}.strategy must be one of ${RECIPE_STRATEGIES.join(', ')}`);
      }
      step.strategy = strategy as RecipeStrategy;
      const localField = optString(raw.localField, `${where}.localField`);
      const foreignField = optString(raw.foreignField, `${where}.foreignField`);
      if ((localField === undefined) !== (foreignField === undefined)) {
        throw new Error(`${where}: localField and foreignField go together`);
      }
      if (localField !== undefined) step.localField = localField;
      if (foreignField !== undefined) step.foreignField = foreignField;
      if (step.strategy !== 'nested-loop' && !localField) {
        throw new Error(`${where}: strategy "${step.strategy}" needs localField and foreignField`);
      }
      if (step.strategy === 'nested-loop' && !localField && ![...placeholdersIn(filter)].some((p) => p.startsWith('parent.'))) {
        throw new Error(`${where}: a nested-loop step needs localField/foreignField or a "{{parent.…}}" placeholder in its filter`);
      }
      const max = step.strategy === 'nested-loop' ? RECIPE_LIMITS.perParentLimit.max : RECIPE_LIMITS.stepLimit.max;
      const limit = optInt(raw.limit, `${where}.limit`, 1, max);
      if (limit !== undefined) step.limit = limit;
      const batchSize = optInt(raw.batchSize, `${where}.batchSize`, 1, RECIPE_LIMITS.batchSize.max);
      if (batchSize !== undefined) step.batchSize = batchSize;
      const concurrency = optInt(raw.concurrency, `${where}.concurrency`, 1, RECIPE_LIMITS.concurrency.max);
      if (concurrency !== undefined) step.concurrency = concurrency;
      const maxParents = optInt(raw.maxParents, `${where}.maxParents`, 1, RECIPE_LIMITS.maxParents.max);
      if (maxParents !== undefined) step.maxParents = maxParents;
    }

    for (const name of placeholdersIn(filter)) {
      if (name.startsWith('parent.')) {
        if (step.strategy !== 'nested-loop') {
          throw new Error(`${where}.filter: "{{${name}}}" is only available in nested-loop steps`);
        }
      } else if (!paramNames.has(name)) {
        throw new Error(`${where}.filter: unknown parameter "{{${name}}}"`);
      }
    }
    stepIds.add(step.id);
    return step;
  });

  const view = optObject(value.view, 'recipe.view') as RecipeView | undefined;
  const name = optString(value.name, 'recipe.name');
  const description = optString(value.description, 'recipe.description');
  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(params.length > 0 ? { params } : {}),
    steps,
    ...(view ? { view } : {}),
  };
}
