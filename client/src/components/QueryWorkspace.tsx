import { useCallback, useEffect, useRef, useState } from 'react';
import { useHotkeys } from '../hooks/useHotkeys';
import { useRunResult } from '../hooks/useRunResult';
import { api, defaultDbFromUri } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { parseQueryText } from '../lib/ejson';
import { contextFor, useProfile } from '../store/useConnectionStore';
import { useTabStore, type QueryTab, type ViewMode } from '../store/useTabStore';
import { badgesOn } from '../store/useViewPrefsStore';
import { useUiStore } from '../store/useUiStore';
import { useSchemas } from '../store/useWorkspaceStore';
import type { RelationLevel } from '../types';
import { BadgeToggle, DataViewer } from './DataViewer';
import { IndexDrawer } from './IndexDrawer';
import { useTransferModal } from './ImportExportModal';
import { focusEditor, JsonEditor } from './JsonEditor';
import { RecipeWorkspace } from './RecipeWorkspace';
import { SaveViewButton, ViewPicker } from './SavedViews';
import { RelationBar } from './RelationBuilder';
import { ModeSwitch, ScriptWorkspace } from './ScriptWorkspace';
import { Splitter } from './Splitter';
import { Button, ErrorBox, inputClass, toast, useServerInfo } from './ui';
import { usePaneSize } from '../store/useLayoutStore';

/**
 * Seam for a future natural-language-to-MQL assistant (Phase 2+). Nothing
 * implements it yet; the workspace only needs to accept a filter/projection/sort.
 */
export interface QueryAssistantProvider {
  suggest(prompt: string, ctx: { db: string; collection: string }): Promise<{ filter?: string; projection?: string; sort?: string }>;
}

/**
 * Every tab keeps its own mounted workspace (hidden when inactive), so results,
 * unfolded rows, selection, scroll and view state stay separate per tab.
 */
export function QueryWorkspace() {
  const tabs = useTabStore((s) => s.tabs);
  const activeId = useTabStore((s) => s.activeId);
  const shownId = tabs.some((t) => t.id === activeId) ? activeId : tabs[0]?.id;
  return (
    <>
      {tabs.map((t) => (
        <div key={t.id} className={t.id === shownId ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} aria-hidden={t.id !== shownId}>
          <TabPane tab={t} active={t.id === shownId} />
        </div>
      ))}
    </>
  );
}

function TabPane({ tab, active }: { tab: QueryTab; active: boolean }) {
  const profile = useProfile(tab.connectionId);

  if (!profile) {
    return <Empty tab={tab}>Select or add a connection in the sidebar to start querying.</Empty>;
  }
  if (tab.mode === 'script') return <ScriptWorkspace tab={tab} active={active} />;
  if (tab.mode === 'recipe') return <RecipeWorkspace tab={tab} active={active} />;
  if (!tab.collection) {
    return (
      <Empty tab={tab} script>
        Pick a collection on the left, apply a saved query preset, or write a free query.
      </Empty>
    );
  }
  // Re-mounted when the tab is pointed at another collection / database.
  return <Workspace key={`${tab.db}/${tab.collection}`} tab={tab} active={active} />;
}

function Empty({ tab, children, script = false }: { tab: QueryTab; children: React.ReactNode; script?: boolean }) {
  const updateTab = useTabStore((s) => s.updateTab);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-sm text-zinc-500">
      <p>{children}</p>
      <div className="flex items-center gap-2">
        <ViewPicker tab={tab} />
        {script && (
          <Button onClick={() => updateTab(tab.id, { mode: 'script' })} title="mongosh-style script: db.policies.find(…), print(…)">
            › Free query (script)
          </Button>
        )}
        {script && (
          <Button onClick={() => updateTab(tab.id, { mode: 'recipe' })} title="Ready-made multi-step fetch templates: dossier, board, query trace">
            ⚗ Recipes
          </Button>
        )}
      </div>
    </div>
  );
}

const VIEW_MODES: { mode: ViewMode; label: string; title: string }[] = [
  { mode: 'table', label: 'Table', title: 'Flat table of top-level fields' },
  { mode: 'nested', label: 'Master-detail', title: 'Master grid with linked collections and embedded arrays in panes below' },
  { mode: 'stack', label: 'Nested table', title: 'Master rows unfold in place into the tables of their details (table-in-table)' },
  { mode: 'tree', label: 'Tree', title: 'Robo 3T-style Key / Value / Type tree; linked documents nest one level further right' },
];

function Workspace({ tab, active }: { tab: QueryTab; active: boolean }) {
  const updateTab = useTabStore((s) => s.updateTab);
  const profile = useProfile(tab.connectionId);
  const forceReadOnly = useServerInfo().data?.forceReadOnly ?? false;
  const schemas = useSchemas();
  const result = useRunResult(tab, forceReadOnly);
  const openTransfer = useTransferModal((s) => s.open);
  const openSchema = useUiStore((s) => s.openSchema);
  const openLink = useUiStore((s) => s.openLink);
  const [parseError, setParseError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [copying, setCopying] = useState(false);
  const [showIndexes, setShowIndexes] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const editorsHeight = usePaneSize('query.editors', 128);

  useEffect(() => setSelection(new Set()), [result.data]);

  const set = (patch: Partial<QueryTab>) => updateTab(tab.id, patch);

  /** Execute the query; `override` carries tab changes made in the same tick (e.g. new links). */
  const run = (override: Partial<QueryTab> = {}) => {
    if (!profile || !tab.collection) return;
    const t = { ...tab, ...override };
    const db = t.db ?? defaultDbFromUri(profile.uri);
    if (!db) {
      setParseError('Select a database first');
      return;
    }
    try {
      const spec = {
        connectionId: profile.id,
        db,
        collection: tab.collection,
        filter: parseQueryText(t.filter, 'Filter'),
        projection: parseQueryText(t.projection, 'Projection'),
        sort: parseQueryText(t.sort, 'Sort'),
        limit: t.limit,
        blueprintId: t.blueprintId,
        levels: t.levels,
        at: Date.now(),
      };
      setParseError(null);
      set({ ...override, db, lastRun: spec });
    } catch (err) {
      setParseError((err as Error).message);
      if (Object.keys(override).length > 0) set(override);
    }
  };

  /** Links changed: show them right away (re-run if the tab already has results). */
  const changeLinks = (levels: RelationLevel[], blueprintId: string | null) => {
    const patch: Partial<QueryTab> = { levels, blueprintId };
    if (levels.length > tab.levels.length && tab.viewMode === 'table') patch.viewMode = 'nested';
    if (tab.lastRun) run(patch);
    else set(patch);
  };

  const copy = async () => {
    const data = result.data;
    if (!profile || !data) return;
    setCopying(true);
    try {
      // Always export full documents server-side (projection ignored on purpose; a
      // partial document must never be pasted). A selection becomes an _id $in filter.
      const s = data.spec;
      let filter = s.filter;
      if (selection.size > 0) {
        const ids = [...selection].map((i) => data.docs[i]?._id);
        if (ids.some((id) => id === undefined)) throw new Error('Selected rows have no _id (projection excludes it)');
        filter = { _id: { $in: ids } };
      }
      const res = await api.exportBundle(contextFor(profile, forceReadOnly), {
        db: s.db,
        collection: s.collection,
        filter,
        sort: s.sort,
        limit: selection.size > 0 ? selection.size : s.limit,
        ...(s.levels.length > 0
          ? { blueprint: { id: s.blueprintId ?? 'adhoc', rootCollection: s.collection, levels: s.levels } }
          : {}),
      });
      const text = res.bundle;
      const counts = res.counts;
      const summary = Object.entries(counts)
        .map(([c, n]) => `${c} ${n}`)
        .join(', ');
      if (await copyText(text)) toast(`Copied EJSON bundle: ${summary}`);
      else openTransfer({ mode: 'copy', text, summary });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setCopying(false);
    }
  };

  const data = result.data;
  const indexDb = tab.db ?? (profile ? defaultDbFromUri(profile.uri) : null);
  const conn = profile ? contextFor(profile, forceReadOnly) : undefined;
  const canCopy = !!data && data.docs.length > 0 && !copying;

  useHotkeys({
    'mod+Enter': () => run(),
    'alt+KeyV': () => {
      const i = VIEW_MODES.findIndex((v) => v.mode === tab.viewMode);
      set({ viewMode: (VIEW_MODES[(i + 1) % VIEW_MODES.length] as (typeof VIEW_MODES)[number]).mode });
    },
    'alt+KeyL': () => openLink({}),
    'alt+KeyI': () => setShowIndexes((v) => !v),
    'alt+KeyC': () => {
      if (canCopy) void copy();
    },
    'alt+KeyP': () => openTransfer({ mode: 'paste' }),
    'alt+KeyF': () => focusEditor(`${tab.id}/filter.json`),
    'alt+KeyG': () => (resultsRef.current?.querySelector<HTMLElement>('[data-grid]') ?? resultsRef.current)?.focus(),
  }, active);

  // Distinct Inspector "Collection" mode: bounded aggregate over the last run's filter.
  const scanDistinct = useCallback(
    (field: string) => {
      if (!profile || !data) return Promise.reject(new Error('Run a query first'));
      const s = data.spec;
      return api.distinct(contextFor(profile, forceReadOnly), { db: s.db, collection: s.collection, field, filter: s.filter });
    },
    [profile, data, forceReadOnly],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ModeSwitch tab={tab} />
        <span className="font-mono text-sm text-zinc-300">
          {tab.db}.<span className="text-zinc-50">{tab.collection}</span>
        </span>
        <ViewPicker tab={tab} />
        <label className="flex items-center gap-1 text-sm text-zinc-400">
          Limit
          <input
            type="number"
            min={1}
            max={1000}
            className={`${inputClass} w-20`}
            value={tab.limit}
            onChange={(e) => set({ limit: Math.min(Math.max(Number(e.target.value) || 1, 1), 1000) })}
          />
        </label>
        <Button onClick={() => openSchema(tab.collection)} title="Document the fields of this collection (Alt+S)">
          ☰ Schema
        </Button>
        <Button onClick={() => setShowIndexes(true)} disabled={!indexDb} title="Collection indexes (Alt+I)">
          ⚿ Indexes
        </Button>
        <SaveViewButton tab={tab} />
        <Button variant="primary" onClick={() => run()} disabled={result.isFetching} title="Run (Ctrl/Cmd+Enter)">
          {result.isFetching ? 'Running…' : '▶ Run'}
        </Button>
      </div>

      <div className="grid shrink-0 grid-cols-[2fr_1fr_1fr] gap-2" style={{ height: editorsHeight }}>
        <JsonEditor path={`${tab.id}/filter.json`} label="Filter" value={tab.filter} onChange={(filter) => set({ filter })} onRun={run} completion={{ collection: tab.collection, kind: 'filter', conn, db: indexDb }} />
        <JsonEditor path={`${tab.id}/projection.json`} label="Projection" value={tab.projection} onChange={(projection) => set({ projection })} onRun={run} completion={{ collection: tab.collection, kind: 'projection', conn, db: indexDb }} />
        <JsonEditor path={`${tab.id}/sort.json`} label="Sort" value={tab.sort} onChange={(sort) => set({ sort })} onRun={run} completion={{ collection: tab.collection, kind: 'sort', conn, db: indexDb }} />
      </div>
      <Splitter sizeKey="query.editors" size={editorsHeight} min={64} label="Resize query editors" />

      <RelationBar tab={tab} active={active} profile={profile} db={indexDb} onChange={changeLinks} />

      {parseError && <ErrorBox error={parseError} />}
      {result.isError && <ErrorBox error={result.error} />}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div className="flex overflow-hidden rounded border border-zinc-700" title="Switch view (Alt+V)">
          {VIEW_MODES.map(({ mode, label, title }) => (
            <button
              key={mode}
              type="button"
              title={title}
              aria-pressed={tab.viewMode === mode}
              onClick={() => set({ viewMode: mode })}
              className={`px-2.5 py-1 ${tab.viewMode === mode ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <BadgeToggle
          on={badgesOn(tab, tab.viewMode)}
          onChange={(on) => set({ badges: { ...tab.badges, [tab.viewMode]: on } })}
        />
        {data && (
          <span className="text-zinc-400">
            {data.docs.length} document{data.docs.length === 1 ? '' : 's'}
            {data.hasMore && ` (limit reached, more available)`} · {data.ms} ms
            {data.stats &&
              ` · ${data.stats.queries} queries: ` +
                data.stats.levels.map((l) => `${l.collection} ${l.docCount}${l.truncated ? '+' : ''}`).join(', ')}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button onClick={copy} disabled={!canCopy} title="Copy as EJSON bundle (Alt+C)">
            {copying ? 'Copying…' : selection.size > 0 ? `⧉ Copy ${selection.size} selected` : '⧉ Copy all as EJSON'}
          </Button>
          <Button onClick={() => openTransfer({ mode: 'paste' })} title="Paste an EJSON bundle (Alt+P)">
            ⇣ Paste…
          </Button>
        </div>
      </div>

      <div ref={resultsRef} tabIndex={-1} className="min-h-0 flex-1 overflow-hidden rounded border border-zinc-800 outline-none">
        {!tab.lastRun && !data && (
          <div className="p-4 text-sm text-zinc-500">Press Run (Ctrl/Cmd+Enter) to execute the query.</div>
        )}
        {data && (
          <DataViewer
            collection={data.spec.collection}
            docs={data.docs}
            nodes={data.nodes}
            viewMode={tab.viewMode}
            schemas={schemas}
            levels={data.spec.levels}
            selection={selection}
            onSelectionChange={setSelection}
            scanDistinct={scanDistinct}
            hiddenSections={tab.hiddenSections ?? []}
            onHiddenSectionsChange={(hiddenSections) => set({ hiddenSections })}
            shownSections={tab.shownSections ?? []}
            onShownSectionsChange={(shownSections) => set({ shownSections })}
            badges={badgesOn(tab, tab.viewMode)}
            nestedUnfold={tab.nestedUnfold ?? null}
            onNestedUnfoldChange={(nestedUnfold) => set({ nestedUnfold })}
            nestedJson={tab.nestedJson ?? false}
            onNestedJsonChange={(nestedJson) => set({ nestedJson })}
            columns={tab.columns ?? {}}
            onColumnsChange={(columns) => set({ columns })}
          />
        )}
      </div>

      {showIndexes && profile && indexDb && tab.collection && (
        <IndexDrawer
          conn={contextFor(profile, forceReadOnly)}
          connectionId={profile.id}
          db={indexDb}
          collection={tab.collection}
          onClose={() => setShowIndexes(false)}
        />
      )}
    </div>
  );
}
