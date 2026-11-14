import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { EjsonDoc, RelationLevel } from '../types';

export type ViewMode = 'tree' | 'table' | 'nested' | 'stack';

/** Frozen parameters of the last executed query; results are cached by react-query under this key. */
export interface RunSpec {
  connectionId: string;
  db: string;
  collection: string;
  filter: EjsonDoc;
  projection: EjsonDoc;
  sort: EjsonDoc;
  limit: number;
  blueprintId: string | null;
  /** Collections linked to the root for this run (empty: plain find). */
  levels: RelationLevel[];
  at: number;
}

export type TabMode = 'query' | 'script';

export interface QueryTab {
  id: string;
  /** Query builder (filter / projection / sort) or free-query script (db.coll.find()…). */
  mode: TabMode;
  /** Script-mode source. */
  script: string;
  connectionId: string | null;
  db: string | null;
  collection: string | null;
  filter: string;
  projection: string;
  sort: string;
  limit: number;
  viewMode: ViewMode;
  /** Saved blueprint the links were loaded from / saved to, if any. */
  blueprintId: string | null;
  /** Working set of links for this tab; edited freely, optionally saved as a blueprint. */
  levels: RelationLevel[];
  /** Detail sections (see `sectionId`) the user switched off in the master-detail views. */
  hiddenSections?: string[];
  /** Embedded sub-document sections (opt-in) the user switched on in the nested table. */
  shownSections?: string[];
  lastRun: RunSpec | null;
}

function blankTab(partial: Partial<QueryTab> = {}): QueryTab {
  return {
    id: crypto.randomUUID(),
    mode: 'query',
    script: '',
    connectionId: null,
    db: null,
    collection: null,
    filter: '{}',
    projection: '{}',
    sort: '{}',
    limit: 100,
    viewMode: 'table',
    blueprintId: null,
    levels: [],
    lastRun: null,
    ...partial,
  };
}

interface TabState {
  tabs: QueryTab[];
  activeId: string;
  addTab: (partial?: Partial<QueryTab>) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  updateTab: (id: string, patch: Partial<QueryTab>) => void;
  /** Drop references to a deleted connection profile. */
  forgetConnection: (connectionId: string) => void;
}

const first = blankTab();

export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
      tabs: [first],
      activeId: first.id,
      addTab: (partial) => {
        const tab = blankTab(partial);
        set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
        return tab.id;
      },
      closeTab: (id) => {
        const { tabs, activeId } = get();
        const index = tabs.findIndex((t) => t.id === id);
        const rest = tabs.filter((t) => t.id !== id);
        if (rest.length === 0) {
          const fresh = blankTab({ connectionId: tabs[index]?.connectionId ?? null, db: tabs[index]?.db ?? null });
          set({ tabs: [fresh], activeId: fresh.id });
          return;
        }
        const nextActive = activeId === id ? (rest[Math.min(index, rest.length - 1)] as QueryTab).id : activeId;
        set({ tabs: rest, activeId: nextActive });
      },
      setActive: (id) => set({ activeId: id }),
      updateTab: (id, patch) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
      forgetConnection: (connectionId) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.connectionId === connectionId
              ? { ...t, connectionId: null, db: null, collection: null, lastRun: null }
              : t,
          ),
        })),
    }),
    {
      name: 'litemongo.tabs',
      version: 3,
      storage: createJSONStorage(() => localStorage),
      // v1 tabs referenced a saved blueprint by id only; v2 carries the links themselves; v3 adds script mode.
      migrate: (persisted, version) => {
        const state = persisted as { tabs?: Partial<QueryTab>[]; activeId?: string };
        const reset = version < 2 ? { blueprintId: null, levels: [] } : {};
        return { ...state, tabs: (state.tabs ?? []).map((t) => blankTab({ ...t, ...reset })) };
      },
      // Never auto-rerun queries on reload (could hit a production jump host unasked).
      partialize: (s) => ({ tabs: s.tabs.map((t) => ({ ...t, lastRun: null })), activeId: s.activeId }),
    },
  ),
);

export function useActiveTab(): QueryTab {
  return useTabStore((s) => s.tabs.find((t) => t.id === s.activeId) ?? (s.tabs[0] as QueryTab));
}

export function tabTitle(tab: QueryTab): string {
  if (tab.mode === 'script') return tab.db ? `› ${tab.db}` : '› script';
  return tab.collection ?? 'New tab';
}
