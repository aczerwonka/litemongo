import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import exampleConfig from '../../../litemongo.config.example.json';
import type { CollectionSchema, QueryPreset, RelationBlueprint, WorkspaceConfig } from '../types';

/** Portable workspace config (litemongo.config.json): schemas, blueprints, presets, renumbering rules. */

export const EXAMPLE_CONFIG = exampleConfig as unknown as WorkspaceConfig;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Light structural validation; the server re-validates whatever it uses. */
export function parseWorkspaceConfig(text: string): WorkspaceConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error('Config must be a JSON object');
  if (parsed.schemas !== undefined && !isRecord(parsed.schemas)) throw new Error('"schemas" must be an object');
  if (parsed.renumberingRules !== undefined && !isRecord(parsed.renumberingRules)) {
    throw new Error('"renumberingRules" must be an object');
  }
  for (const key of ['relationBlueprints', 'queryPresets'] as const) {
    if (parsed[key] !== undefined && !Array.isArray(parsed[key])) throw new Error(`"${key}" must be an array`);
  }
  const presets = (parsed.queryPresets ?? []) as unknown[];
  presets.forEach((p, i) => {
    if (!isRecord(p) || typeof p.id !== 'string' || typeof p.collection !== 'string') {
      throw new Error(`queryPresets[${i}] needs "id" and "collection"`);
    }
  });
  const blueprints = (parsed.relationBlueprints ?? []) as unknown[];
  blueprints.forEach((b, i) => {
    if (!isRecord(b) || typeof b.id !== 'string' || typeof b.rootCollection !== 'string' || !Array.isArray(b.levels)) {
      throw new Error(`relationBlueprints[${i}] needs "id", "rootCollection" and "levels"`);
    }
  });
  return parsed as WorkspaceConfig;
}

/** Where a Nested View badge (`code` display key) is configured. */
export type BadgeTarget =
  /** Root documents of a collection: schemas[collection].displayBadgeField. */
  | { kind: 'collection'; collection: string }
  /** Embedded array at `path`: schemas[collection].coreFields…[path].displayBadgeField. */
  | { kind: 'array'; collection: string; path: string[] };

/** Returns a new config with the badge field set (or removed when `field` is null). */
export function withBadgeField(config: WorkspaceConfig, target: BadgeTarget, field: string | null): WorkspaceConfig {
  const next = structuredClone(config);
  const assign = (obj: Record<string, unknown>) => {
    if (field) obj.displayBadgeField = field;
    else delete obj.displayBadgeField;
  };
  next.schemas ??= {};
  const schema = (next.schemas[target.collection] ??= {});
  if (target.kind === 'collection') {
    assign(schema as Record<string, unknown>);
    return next;
  }
  let node = (schema.coreFields ??= {}) as Record<string, unknown>;
  target.path.forEach((segment, i) => {
    const existing = node[segment];
    const fieldDef: Record<string, unknown> = isRecord(existing) ? existing : { type: 'array' };
    node[segment] = fieldDef;
    if (i === target.path.length - 1) {
      assign(fieldDef);
    } else {
      if (!isRecord(fieldDef.items)) fieldDef.items = {};
      node = fieldDef.items as Record<string, unknown>;
    }
  });
  return next;
}

interface WorkspaceState {
  config: WorkspaceConfig;
  setConfig: (config: WorkspaceConfig) => void;
  setBadgeField: (target: BadgeTarget, field: string | null) => void;
  /** Create or edit one collection's schema. */
  updateSchema: (collection: string, update: (schema: CollectionSchema) => CollectionSchema) => void;
  removeSchema: (collection: string) => void;
  /** Insert or replace a saved relation blueprint (by id). */
  saveBlueprint: (blueprint: RelationBlueprint) => void;
  removeBlueprint: (id: string) => void;
  resetToExample: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      config: EXAMPLE_CONFIG,
      setConfig: (config) => set({ config }),
      setBadgeField: (target, field) => set((s) => ({ config: withBadgeField(s.config, target, field) })),
      updateSchema: (collection, update) =>
        set((s) => ({
          config: { ...s.config, schemas: { ...s.config.schemas, [collection]: update(s.config.schemas?.[collection] ?? {}) } },
        })),
      removeSchema: (collection) =>
        set((s) => {
          const schemas = { ...s.config.schemas };
          delete schemas[collection];
          return { config: { ...s.config, schemas } };
        }),
      saveBlueprint: (blueprint) =>
        set((s) => {
          const list = s.config.relationBlueprints ?? [];
          const exists = list.some((b) => b.id === blueprint.id);
          return {
            config: {
              ...s.config,
              relationBlueprints: exists ? list.map((b) => (b.id === blueprint.id ? blueprint : b)) : [...list, blueprint],
            },
          };
        }),
      removeBlueprint: (id) =>
        set((s) => ({
          config: { ...s.config, relationBlueprints: (s.config.relationBlueprints ?? []).filter((b) => b.id !== id) },
        })),
      resetToExample: () => set({ config: EXAMPLE_CONFIG }),
    }),
    { name: 'litemongo.workspace', version: 1, storage: createJSONStorage(() => localStorage) },
  ),
);

export function usePresets(): QueryPreset[] {
  return useWorkspaceStore((s) => s.config.queryPresets) ?? [];
}

export function useBlueprints(): RelationBlueprint[] {
  return useWorkspaceStore((s) => s.config.relationBlueprints) ?? EMPTY_BLUEPRINTS;
}
const EMPTY_BLUEPRINTS: RelationBlueprint[] = [];

export function useSchemas(): Record<string, CollectionSchema> {
  return useWorkspaceStore((s) => s.config.schemas) ?? EMPTY_SCHEMAS;
}
const EMPTY_SCHEMAS: Record<string, CollectionSchema> = {};

export function useSchema(collection: string | null | undefined): CollectionSchema | undefined {
  return useWorkspaceStore((s) => (collection ? s.config.schemas?.[collection] : undefined));
}

/**
 * Badge field for an array at `path` (segments, no indices), from
 * schema.coreFields[...].displayBadgeField; falls back to `code` when items have one.
 */
export function badgeFieldFor(
  schema: CollectionSchema | undefined,
  path: string[],
  sampleItem: unknown,
): string | undefined {
  let node: unknown = schema?.coreFields;
  for (let i = 0; i < path.length; i++) {
    if (!isRecord(node)) {
      node = undefined;
      break;
    }
    const field = node[path[i] as string];
    node = i === path.length - 1 ? field : isRecord(field) ? field.items : undefined;
  }
  if (isRecord(node) && typeof node.displayBadgeField === 'string') return node.displayBadgeField;
  if (isRecord(sampleItem) && typeof sampleItem.code === 'string') return 'code';
  return undefined;
}
