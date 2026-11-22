import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ColumnPrefs, EjsonDoc, RelationLevel } from '../types';

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

export type TabMode = 'query' | 'script' | 'recipe';

/** Presentation of a recipe run. */
export type RecipeViewMode = 'dossier' | 'board' | 'trace' | 'json';

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
  /** `code` badges per view mode in this tab; missing = on. */
  badges?: Partial<Record<ViewMode, boolean>>;
  /** Nested table: "Unfold all" / "Fold all" last used in this tab; missing = automatic. */
  nestedUnfold?: boolean | null;
  /** Nested table: rows without details unfold into their JSON document. */
  nestedJson?: boolean;
  lastRun: RunSpec | null;
  /** Saved view this tab was loaded from / saved to. */
  presetId?: string | null;
  /** Column order / hidden columns per grid source. */
  columns?: ColumnPrefs;
  /** Recipe mode: built-in or saved recipe the editor was loaded from. */
  recipeId?: string | null;
  /** Recipe mode: the recipe being edited / run, as JSON text. */
  recipeText?: string;
  /** Recipe mode: parameter values as typed. */
  recipeParams?: Record<string, string>;
  /** Recipe mode: chosen presentation (missing: the recipe's own view). */
  recipeView?: RecipeViewMode | null;
  /** Recipe mode: name shown on the tab. */
  recipeName?: string;
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
  /** Last active tab per connection (key: connection id, '' = no connection). */
  lastActive: Record<string, string>;
  addTab: (partial?: Partial<QueryTab>) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  updateTab: (id: string, patch: Partial<QueryTab>) => void;
  /** Drop references to a deleted connection profile. */
  forgetConnection: (connectionId: string) => void;
  /** Bring a connection's workspace forward: its last tab, or a new one. */
  showConnection: (connectionId: string, db?: string | null) => void;
  /** Close every tab of a connection. */
  closeConnectionTabs: (connectionId: string) => void;
}

export function groupKey(tab: Pick<QueryTab, 'connectionId'>): string {
  return tab.connectionId ?? '';
}

function withLast(last: Record<string, string>, tab: QueryTab | undefined): Record<string, string> {
  return tab ? { ...last, [groupKey(tab)]: tab.id } : last;
}

const first = blankTab();

export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
      tabs: [first],
      activeId: first.id,
      lastActive: {},
      addTab: (partial) => {
        const tab = blankTab(partial);
        set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id, lastActive: withLast(s.lastActive, tab) }));
        return tab.id;
      },
      closeTab: (id) => {
        const { tabs, activeId, lastActive } = get();
        const closing = tabs.find((t) => t.id === id);
        if (!closing) return;
        const rest = tabs.filter((t) => t.id !== id);
        if (rest.length === 0) {
          const fresh = blankTab({ connectionId: closing.connectionId, db: closing.db });
          set({ tabs: [fresh], activeId: fresh.id, lastActive: withLast({}, fresh) });
          return;
        }
        if (activeId !== id) {
          set({ tabs: rest });
          return;
        }
        // Stay inside the same connection: its neighbouring tab, else another connection's last tab.
        const group = tabs.filter((t) => groupKey(t) === groupKey(closing));
        const at = group.findIndex((t) => t.id === id);
        const sameGroup = group.filter((t) => t.id !== id);
        const next =
          sameGroup[Math.min(at, sameGroup.length - 1)] ??
          rest.find((t) => t.id === lastActive[groupKey(rest[0] as QueryTab)]) ??
          (rest[0] as QueryTab);
        const last = { ...lastActive };
        if (!sameGroup.length) delete last[groupKey(closing)];
        set({ tabs: rest, activeId: next.id, lastActive: withLast(last, next) });
      },
      setActive: (id) => set((s) => ({ activeId: id, lastActive: withLast(s.lastActive, s.tabs.find((t) => t.id === id)) })),
      showConnection: (connectionId, db) => {
        const { tabs, lastActive, setActive, addTab } = get();
        const own = tabs.filter((t) => t.connectionId === connectionId);
        const target = own.find((t) => t.id === lastActive[connectionId]) ?? own[0];
        if (target) setActive(target.id);
        else addTab({ connectionId, db: db ?? null });
      },
      closeConnectionTabs: (connectionId) => {
        const { tabs, activeId, lastActive } = get();
        const rest = tabs.filter((t) => t.connectionId !== connectionId);
        const last = { ...lastActive };
        delete last[connectionId];
        if (rest.length === 0) {
          const fresh = blankTab();
          set({ tabs: [fresh], activeId: fresh.id, lastActive: withLast(last, fresh) });
          return;
        }
        const keep = rest.some((t) => t.id === activeId);
        const next = keep ? activeId : (rest.find((t) => Object.values(last).includes(t.id)) ?? (rest[0] as QueryTab)).id;
        set({ tabs: rest, activeId: next, lastActive: last });
      },
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
      partialize: (s) => ({ tabs: s.tabs.map((t) => ({ ...t, lastRun: null })), activeId: s.activeId, lastActive: s.lastActive }),
    },
  ),
);

export function useActiveTab(): QueryTab {
  return useTabStore((s) => s.tabs.find((t) => t.id === s.activeId) ?? (s.tabs[0] as QueryTab));
}

/** Tabs of the active tab's connection, in tab-bar order. */
export function visibleTabs(state: Pick<TabState, 'tabs' | 'activeId'>): QueryTab[] {
  const active = state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0];
  return active ? state.tabs.filter((t) => groupKey(t) === groupKey(active)) : [];
}

export function tabTitle(tab: QueryTab): string {
  if (tab.mode === 'script') return tab.db ? `› ${tab.db}` : '› script';
  if (tab.mode === 'recipe') return `⚗ ${tab.recipeName ?? 'recipe'}`;
  return tab.collection ?? 'New tab';
}
