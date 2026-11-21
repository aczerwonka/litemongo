// Config types are shared with the server (type-only import, erased at build).
import type {
  CollectionSchema,
  RelationBlueprint,
  RelationLevel,
  RenumberingRules,
  WorkspaceConfig as ServerWorkspaceConfig,
} from '../../server/src/lib/config';
import type {
  Recipe,
  RecipeParam,
  RecipeStep,
  RecipeStepDisplay,
  RecipeStrategy,
  RecipeView,
} from '../../server/src/lib/recipe';

export type { Recipe, RecipeParam, RecipeStep, RecipeStepDisplay, RecipeStrategy, RecipeView };

export type { CollectionSchema, RelationBlueprint, RelationLevel, RenumberingRules };

/** Canonical Extended JSON document as returned by the API (plain JSON). */
export type EjsonDoc = Record<string, unknown>;

/** Columns of one grid source (collection, or embedded array path in it): order and hidden ones. */
export interface ColumnPref {
  /** Column ids in display order (fields, `__child_<collection>`); others follow in their natural order. */
  order?: string[];
  hidden?: string[];
}

/** Column prefs keyed by grid source (see `columnsKey`). */
export type ColumnPrefs = Record<string, ColumnPref>;

/**
 * Saved query / view ("Saved views"): the query itself plus how it is shown —
 * joins, detail sections switched on/off, columns and their order.
 */
export interface QueryPreset {
  id: string;
  name: string;
  collection: string;
  filter?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  limit?: number;
  relationBlueprintId?: string;
  /** Joins (linked collections) saved with the view; wins over relationBlueprintId. */
  levels?: RelationLevel[];
  viewMode?: 'tree' | 'table' | 'nested' | 'stack';
  hiddenSections?: string[];
  shownSections?: string[];
  columns?: ColumnPrefs;
  nestedJson?: boolean;
}

export interface WorkspaceConfig extends Omit<ServerWorkspaceConfig, 'queryPresets'> {
  queryPresets?: QueryPreset[];
}

export interface MasterDetailNode {
  collection: string;
  doc: EjsonDoc;
  children: Record<string, MasterDetailNode[]>;
}

export interface LevelStats {
  level: number;
  collection: string;
  parentCollection: string;
  keyCount: number;
  docCount: number;
  truncated: boolean;
  ms: number;
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
  idMap: { collection: string; path: string; type: string; old: string; new: string }[];
  links: {
    collection: string;
    documentId: string;
    path: string;
    old: string;
    new: string;
    references: string;
    declared: boolean;
  }[];
  truncatedLists: boolean;
  warnings: string[];
}

/** One fetched document of a recipe run, with its children keyed by step id. */
export interface RecipeNode {
  step: string;
  collection: string;
  doc: EjsonDoc;
  children: Record<string, RecipeNode[]>;
}

export interface RecipeStepStats {
  step: string;
  collection: string;
  strategy: RecipeStrategy | 'root';
  parent: string | null;
  queries: number;
  keys: number;
  docs: number;
  truncated: boolean;
  skippedParents: number;
  ms: number;
}

export interface RecipeTraceEntry {
  step: string;
  collection: string;
  strategy: RecipeStrategy | 'root';
  label: string;
  start: number;
  ms: number;
  docs: number;
  keys?: number;
}

export interface RecipeRunResponse {
  db: string;
  recipeId: string;
  roots: RecipeNode[];
  steps: RecipeStepStats[];
  trace: RecipeTraceEntry[];
  traceTruncated: boolean;
  warnings: string[];
  queries: number;
  totalMs: number;
}

export interface PasteResult {
  targetDb: string;
  inserted: number;
  failed: number;
  collections: Record<string, { inserted: number; failed: number; errors: string[] }>;
}
