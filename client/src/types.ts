// Config types are shared with the server (type-only import, erased at build).
import type {
  CollectionSchema,
  RelationBlueprint,
  RelationLevel,
  RenumberingRules,
  WorkspaceConfig as ServerWorkspaceConfig,
} from '../../server/src/lib/config';

export type { CollectionSchema, RelationBlueprint, RelationLevel, RenumberingRules };

/** Canonical Extended JSON document as returned by the API (plain JSON). */
export type EjsonDoc = Record<string, unknown>;

export interface QueryPreset {
  id: string;
  name: string;
  collection: string;
  filter?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  limit?: number;
  relationBlueprintId?: string;
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

export interface PasteResult {
  targetDb: string;
  inserted: number;
  failed: number;
  collections: Record<string, { inserted: number; failed: number; errors: string[] }>;
}
