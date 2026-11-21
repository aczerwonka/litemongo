import type { Recipe } from './recipe.js';

/**
 * Types for the portable workspace configuration (litemongo.config.json).
 * The server is stateless: the browser sends the parts it needs per request.
 */

export interface CollectionSchema {
  description?: string;
  displayBadgeField?: string;
  /** Paths holding identifiers that get fresh values on remap, e.g. "_id", "covers[].coverId". */
  idPaths?: string[];
  /** Paths whose values are domain codes and must never be remapped. */
  protectedCodePaths?: string[];
  /** Soft foreign keys: local path -> "collection.path" it references. */
  foreignKeys?: Record<string, string>;
  coreFields?: Record<string, unknown>;
}

export interface RelationLevel {
  level: number;
  collection: string;
  /** Collection whose documents provide `localField`. Defaults to the previous level. */
  parentCollection?: string;
  localField: string;
  foreignField: string;
  displayBadgeField?: string;
}

export interface RelationBlueprint {
  id: string;
  name?: string;
  rootCollection: string;
  levels: RelationLevel[];
}

export type RenumberStrategy = 'SUFFIX_TIMESTAMP' | 'UUID_SHORT' | 'KEEP' | 'OFFSET';

export interface RenumberRule {
  strategy: RenumberStrategy;
  prefix?: string;
  /** For OFFSET on numeric ids. */
  offset?: number;
}

export type RenumberingRules = Record<string, Record<string, RenumberRule>>;

export interface WorkspaceConfig {
  version?: string;
  workspaceName?: string;
  schemas?: Record<string, CollectionSchema>;
  relationBlueprints?: RelationBlueprint[];
  renumberingRules?: RenumberingRules;
  queryPresets?: unknown[];
  /** Fetch recipes (multi-step templates), see lib/recipe.ts. */
  recipes?: Recipe[];
}

const STRATEGIES: readonly RenumberStrategy[] = ['SUFFIX_TIMESTAMP', 'UUID_SHORT', 'KEEP', 'OFFSET'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`${where} must be an array of strings`);
  }
  return value as string[];
}

/** Upper bound on linked collections per blueprint (each costs one $in query). */
export const MAX_BLUEPRINT_LINKS = 8;

export function parseBlueprint(value: unknown): RelationBlueprint {
  if (!isRecord(value)) throw new Error('blueprint must be an object');
  const { id, name, rootCollection, levels } = value;
  if (typeof rootCollection !== 'string' || !rootCollection) {
    throw new Error('blueprint.rootCollection must be a non-empty string');
  }
  if (!Array.isArray(levels)) throw new Error('blueprint.levels must be an array');
  if (levels.length > MAX_BLUEPRINT_LINKS) {
    throw new Error(`blueprint supports at most ${MAX_BLUEPRINT_LINKS} linked collections`);
  }
  const parsedLevels = levels.map((lvl, i): RelationLevel => {
    if (!isRecord(lvl)) throw new Error(`blueprint.levels[${i}] must be an object`);
    for (const key of ['collection', 'localField', 'foreignField'] as const) {
      if (typeof lvl[key] !== 'string' || !lvl[key]) {
        throw new Error(`blueprint.levels[${i}].${key} must be a non-empty string`);
      }
    }
    return {
      level: typeof lvl.level === 'number' ? lvl.level : i + 2,
      collection: lvl.collection as string,
      localField: lvl.localField as string,
      foreignField: lvl.foreignField as string,
      ...(typeof lvl.parentCollection === 'string' ? { parentCollection: lvl.parentCollection } : {}),
      ...(typeof lvl.displayBadgeField === 'string' ? { displayBadgeField: lvl.displayBadgeField } : {}),
    };
  });
  // Several collections may hang off the same parent (siblings), but the tree
  // stays at most 3 levels deep including the root: one $in query per link.
  const depthOf = new Map<string, number>([[rootCollection, 1]]);
  let previous = rootCollection;
  for (const [i, lvl] of parsedLevels.entries()) {
    const parent = lvl.parentCollection ?? previous;
    const parentDepth = depthOf.get(parent);
    if (parentDepth === undefined) {
      throw new Error(`blueprint.levels[${i}].parentCollection "${parent}" is not the root or an earlier level`);
    }
    if (parentDepth >= 3) {
      throw new Error('blueprint supports at most 3 levels including the root');
    }
    depthOf.set(lvl.collection, parentDepth + 1);
    previous = lvl.collection;
  }
  return {
    id: typeof id === 'string' ? id : 'adhoc',
    ...(typeof name === 'string' ? { name } : {}),
    rootCollection,
    levels: parsedLevels,
  };
}

export function parseSchemas(value: unknown): Record<string, CollectionSchema> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error('schemas must be an object keyed by collection');
  const out: Record<string, CollectionSchema> = {};
  for (const [collection, raw] of Object.entries(value)) {
    if (!isRecord(raw)) throw new Error(`schemas.${collection} must be an object`);
    const idPaths = stringArray(raw.idPaths, `schemas.${collection}.idPaths`);
    const protectedCodePaths = stringArray(raw.protectedCodePaths, `schemas.${collection}.protectedCodePaths`);
    let foreignKeys: Record<string, string> | undefined;
    if (raw.foreignKeys !== undefined) {
      if (!isRecord(raw.foreignKeys) || !Object.values(raw.foreignKeys).every((v) => typeof v === 'string')) {
        throw new Error(`schemas.${collection}.foreignKeys must map paths to "collection.path" strings`);
      }
      foreignKeys = raw.foreignKeys as Record<string, string>;
    }
    out[collection] = {
      ...(idPaths ? { idPaths } : {}),
      ...(protectedCodePaths ? { protectedCodePaths } : {}),
      ...(foreignKeys ? { foreignKeys } : {}),
    };
  }
  return out;
}

export function parseRenumberingRules(value: unknown): RenumberingRules {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error('renumberingRules must be an object keyed by collection');
  const out: RenumberingRules = {};
  for (const [collection, rules] of Object.entries(value)) {
    if (!isRecord(rules)) throw new Error(`renumberingRules.${collection} must be an object`);
    out[collection] = {};
    for (const [path, rule] of Object.entries(rules)) {
      if (!isRecord(rule) || !STRATEGIES.includes(rule.strategy as RenumberStrategy)) {
        throw new Error(
          `renumberingRules.${collection}.${path}.strategy must be one of ${STRATEGIES.join(', ')}`,
        );
      }
      out[collection][path] = {
        strategy: rule.strategy as RenumberStrategy,
        ...(typeof rule.prefix === 'string' ? { prefix: rule.prefix } : {}),
        ...(typeof rule.offset === 'number' ? { offset: rule.offset } : {}),
      };
    }
  }
  return out;
}
