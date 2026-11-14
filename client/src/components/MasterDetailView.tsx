import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { classify } from '../lib/ejson';
import type { CollectionSchema, EjsonDoc, MasterDetailNode, RelationLevel } from '../types';
import type { DistinctScan } from './DistinctPopover';
import { DocTree } from './DocTree';
import { arraySource, Grid, relationBadge, rootSource, type GridRow, type TableSource } from './Grid';
import { CodeBadge } from './values';

/**
 * Master-Detail view: three linked panes instead of tables nested in tables.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ master grid (level 1)                        │
 *   ├───────────────────────────┬──────────────────┤
 *   │ detail of the active row  │ detail of the    │
 *   │ (level 2), one tab per    │ active level 2   │
 *   │ linked collection / array │ row (level 3)    │
 *   └───────────────────────────┴──────────────────┘
 *
 * Moving through the master grid updates the panes below instantly: everything
 * was already fetched by the batched $in engine, nothing is queried on click.
 */

const MAX_DEPTH = 3;
const DOC_TAB = 'doc';

export interface MasterDetailViewProps {
  collection: string;
  docs: EjsonDoc[];
  nodes: MasterDetailNode[] | null;
  schemas: Record<string, CollectionSchema>;
  levels: RelationLevel[];
  selection: Set<number>;
  onSelectionChange: (selection: Set<number>) => void;
  scanDistinct?: DistinctScan | undefined;
  hiddenSections?: string[];
}

export interface Section {
  key: string;
  /** Linked collection, embedded array of sub-documents, or embedded sub-document (opt-in). */
  kind: 'relation' | 'array' | 'object';
  label: string;
  rows: GridRow[];
  source: TableSource;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return classify(v).kind === 'object';
}

/** Stable id of a detail section, used to switch it on/off: "⛓claims", "policies.covers[]", "policies.premium{}". */
export function sectionId(s: Section): string {
  if (s.kind === 'relation') return `⛓${s.label}`;
  return `${s.source.collection}.${s.label}${s.kind === 'object' ? '{}' : ''}`;
}

/** Display path of a source's rows (`covers[]`, `premium`, …; '' for whole documents). */
function displayOf(source: TableSource): string {
  return source.display ?? (source.arrayPath.length ? `${source.arrayPath.join('[].')}[]` : '');
}

/**
 * Detail tabs of a row: linked collections first, then embedded arrays of
 * sub-documents, then (with `objects`) embedded sub-documents such as `premium`.
 */
export function sectionsFor(
  row: GridRow,
  source: TableSource,
  schemas: Record<string, CollectionSchema>,
  levels: RelationLevel[],
  opts: { objects?: boolean } = {},
): Section[] {
  const prefix = displayOf(source);
  const join = (name: string) => (prefix ? `${prefix}.${name}` : name);
  const sections: Section[] = [];
  for (const [child, list] of Object.entries(row.node?.children ?? {})) {
    sections.push({
      key: `rel:${child}`,
      kind: 'relation',
      label: child,
      rows: list.map((n, index) => ({ index, doc: n.doc, node: n })),
      source: {
        collection: child,
        arrayPath: [],
        badgeField: relationBadge(child, schemas, levels, list[0]?.doc),
        badgeTarget: { kind: 'collection', collection: child },
      },
    });
  }
  for (const [field, value] of Object.entries(row.doc)) {
    if (!Array.isArray(value)) continue;
    const items = value.filter(isObj);
    if (items.length === 0) continue;
    const arrayPath = [...source.arrayPath, field];
    const label = join(`${field}[]`);
    sections.push({
      key: `arr:${field}`,
      kind: 'array',
      label,
      rows: items.map((doc, index) => ({ index, doc, node: undefined })),
      source: { ...arraySource(source.collection, arrayPath, schemas, items[0]), display: label },
    });
  }
  if (opts.objects) {
    for (const [field, value] of Object.entries(row.doc)) {
      if (field === '_id' || !isObj(value) || Object.keys(value).length === 0) continue;
      const label = join(field);
      sections.push({
        key: `obj:${field}`,
        kind: 'object',
        label,
        rows: [{ index: 0, doc: value, node: undefined }],
        source: { ...arraySource(source.collection, [...source.arrayPath, field], schemas, value), display: label },
      });
    }
  }
  return sections;
}

/** Focus the first grid inside `el`, or the pane itself when it shows a document. */
function focusPane(el: HTMLElement | null): void {
  if (!el) return;
  (el.querySelector<HTMLElement>('[data-grid]') ?? el).focus();
}

export function MasterDetailView({
  collection,
  docs,
  nodes,
  schemas,
  levels,
  selection,
  onSelectionChange,
  scanDistinct,
  hiddenSections = [],
}: MasterDetailViewProps) {
  const rows = useMemo<GridRow[]>(() => docs.map((doc, index) => ({ index, doc, node: nodes?.[index] })), [docs, nodes]);
  const source = useMemo(() => rootSource(collection, schemas, docs[0]), [collection, schemas, docs]);
  const [active, setActive] = useState<number | null>(rows.length ? 0 : null);
  const [tab, setTab] = useState<string | null>(null);
  const [ratio, setRatio] = useState(0.45);
  /** Detail panes can be unpinned (hidden) to give the master grid the whole height. */
  const [showDetail, setShowDetail] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const masterRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const cycleRef = useRef<(direction: 1 | -1) => void>(() => undefined);

  useEffect(() => setActive(rows.length ? 0 : null), [rows]);

  const activeRow = active === null ? undefined : rows[active];

  const onDividerDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!(e.buttons & 1) || !rootRef.current) return;
    const box = rootRef.current.getBoundingClientRect();
    setRatio(Math.max(0.15, Math.min(0.85, (e.clientY - box.top) / box.height)));
  };

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      <div ref={masterRef} className={showDetail ? 'min-h-0 shrink-0 grow-0' : 'min-h-0 flex-1'} style={showDetail ? { flexBasis: `${ratio * 100}%` } : undefined}>
        <Grid
          rows={rows}
          source={source}
          schemas={schemas}
          levels={levels}
          active={active}
          onActive={setActive}
          selection={selection}
          onSelectionChange={onSelectionChange}
          scanDistinct={scanDistinct}
          onEnter={() => {
            setShowDetail(true);
            requestAnimationFrame(() => focusPane(detailRef.current));
          }}
          onCycleTab={(d) => cycleRef.current(d)}
        />
      </div>
      {!showDetail && (
        <button
          type="button"
          onClick={() => setShowDetail(true)}
          className="shrink-0 border-t border-zinc-800 bg-zinc-900 px-2 py-1 text-left text-xs text-zinc-400 hover:text-zinc-100"
        >
          ▴ Show details{activeRow ? ` of row ${activeRow.index + 1}` : ''}
        </button>
      )}
      {showDetail && (
      <>
      <div
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize"
        className="h-1.5 shrink-0 cursor-row-resize border-y border-zinc-800 bg-zinc-900 hover:bg-emerald-700"
        onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
        onPointerMove={onDividerDrag}
      />
      <div className="min-h-0 flex-1">
        {activeRow ? (
          <DetailPane
            paneRef={detailRef}
            row={activeRow}
            source={source}
            schemas={schemas}
            levels={levels}
            depth={2}
            hidden={hiddenSections}
            tab={tab}
            onTab={setTab}
            cycleRef={cycleRef}
            onBack={() => focusPane(masterRef.current)}
            onHide={() => {
              setShowDetail(false);
              focusPane(masterRef.current);
            }}
          />
        ) : (
          <div className="p-4 text-sm text-zinc-500">Select a row to see its linked documents and nested arrays.</div>
        )}
      </div>
      </>
      )}
    </div>
  );
}

/** Tabs + content describing one row: its linked collections, embedded arrays and the full document. */
function DetailPane({
  paneRef,
  row,
  source,
  schemas,
  levels,
  depth,
  hidden,
  tab,
  onTab,
  cycleRef,
  onBack,
  onHide,
}: {
  hidden: string[];
  paneRef: RefObject<HTMLDivElement | null>;
  row: GridRow;
  /** Source of the grid `row` belongs to. */
  source: TableSource;
  schemas: Record<string, CollectionSchema>;
  levels: RelationLevel[];
  /** Level of the grids shown in this pane (2 or 3). */
  depth: number;
  tab: string | null;
  onTab: (tab: string) => void;
  /** Lets the parent grid switch this pane's tabs with [ and ]. */
  cycleRef?: RefObject<(direction: 1 | -1) => void>;
  onBack: () => void;
  /** Unpin (hide) this pane. */
  onHide: () => void;
}) {
  const sections = useMemo(
    () => sectionsFor(row, source, schemas, levels).filter((s) => !hidden.includes(sectionId(s))),
    [row, source, schemas, levels, hidden],
  );
  const keys = [...sections.map((s) => s.key), DOC_TAB];
  const current = tab && keys.includes(tab) ? tab : (sections.find((s) => s.rows.length > 0)?.key ?? DOC_TAB);
  const section = sections.find((s) => s.key === current);
  // Sub-pane tab is kept here so it survives moving between rows.
  const [subTab, setSubTab] = useState<string | null>(null);

  const cycle = (direction: 1 | -1) => {
    const next = keys[(keys.indexOf(current) + direction + keys.length) % keys.length];
    if (next) onTab(next);
  };
  if (cycleRef) cycleRef.current = cycle;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === '[' || e.key === ']') cycle(e.key === ']' ? 1 : -1);
    else if (e.key === 'ArrowLeft' || e.key === 'Escape') onBack();
    else return;
    e.preventDefault();
  };

  const badgeValue = source.badgeField ? row.doc[source.badgeField] : undefined;

  return (
    <div ref={paneRef} tabIndex={-1} onKeyDown={onKeyDown} className="flex h-full min-w-0 flex-col outline-none">
      <div role="tablist" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-900 px-2 text-xs">
        <span className="mr-1 flex shrink-0 items-center gap-1 py-1 text-zinc-500">
          {source.arrayPath.length ? `${source.arrayPath.join('.')}[${row.index}]` : source.collection}
          {badgeValue !== undefined && <CodeBadge value={badgeValue} title={source.badgeField} />}
          <span className="text-zinc-600">›</span>
        </span>
        {sections.map((s) => (
          <TabButton key={s.key} active={s.key === current} onClick={() => onTab(s.key)}>
            <span className={s.kind === 'relation' ? 'text-emerald-400' : 'text-sky-300'}>{s.kind === 'relation' ? '⛓' : '▤'}</span>{' '}
            {s.label} <span className={s.rows.length ? 'text-zinc-300' : 'text-zinc-600'}>{s.rows.length}</span>
          </TabButton>
        ))}
        <TabButton active={current === DOC_TAB} onClick={() => onTab(DOC_TAB)}>
          {'{ }'} Document
        </TabButton>
        <button
          type="button"
          title="Unpin: hide this detail pane"
          aria-label="Hide detail pane"
          onClick={onHide}
          className="sticky right-0 ml-auto shrink-0 rounded bg-zinc-900 px-1.5 py-1 text-zinc-500 hover:text-zinc-100"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {section ? (
          <SectionBody
            key={`${row.index}:${section.key}`}
            section={section}
            schemas={schemas}
            levels={levels}
            depth={depth}
            hidden={hidden}
            subTab={subTab}
            onSubTab={setSubTab}
            onBack={onBack}
            onCycleTab={cycle}
          />
        ) : (
          <div className="h-full overflow-auto p-2 font-mono text-[13px] leading-6">
            {source.arrayPath.length === 0 ? (
              <DocTree doc={row.doc} node={row.node} collection={source.collection} schemas={schemas} defaultOpen />
            ) : (
              <DocTree doc={row.doc} collection={source.collection} schemas={{}} defaultOpen />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`shrink-0 border-b-2 px-2 py-1.5 font-mono whitespace-nowrap ${active ? 'border-emerald-500 text-zinc-50' : 'border-transparent text-zinc-400 hover:text-zinc-100'}`}
    >
      {children}
    </button>
  );
}

/** Grid for one detail tab, plus (below the depth limit) a pane for its own active row. */
function SectionBody({
  section,
  schemas,
  levels,
  depth,
  hidden,
  subTab,
  onSubTab,
  onBack,
  onCycleTab,
}: {
  section: Section;
  schemas: Record<string, CollectionSchema>;
  levels: RelationLevel[];
  depth: number;
  hidden: string[];
  subTab: string | null;
  onSubTab: (tab: string) => void;
  onBack: () => void;
  onCycleTab: (direction: 1 | -1) => void;
}) {
  const [active, setActive] = useState<number | null>(section.rows.length ? 0 : null);
  const [showSub, setShowSub] = useState(true);
  const gridRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const activeRow = active === null ? undefined : section.rows[active];
  const canSubPane = depth < MAX_DEPTH && !!activeRow;
  const hasSubPane = canSubPane && showSub;

  if (section.rows.length === 0) {
    return (
      <div className="p-4 text-sm text-zinc-500">
        No {section.label} documents are linked to this row.
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0">
      <div ref={gridRef} className="min-w-0 flex-1">
        <Grid
          rows={section.rows}
          source={section.source}
          schemas={schemas}
          levels={levels}
          active={active}
          onActive={setActive}
          maxColumns={24}
          onBack={onBack}
          onCycleTab={onCycleTab}
          {...(canSubPane
            ? {
                onEnter: () => {
                  setShowSub(true);
                  requestAnimationFrame(() => focusPane(subRef.current));
                },
              }
            : {})}
        />
      </div>
      {canSubPane && !showSub && (
        <button
          type="button"
          title="Show the details of the active row"
          onClick={() => setShowSub(true)}
          className="shrink-0 border-l border-zinc-800 bg-zinc-900 px-1 text-xs text-zinc-400 [writing-mode:vertical-rl] hover:text-zinc-100"
        >
          ◂ Show details
        </button>
      )}
      {hasSubPane && activeRow && (
        <div className="w-[45%] shrink-0 border-l border-zinc-800">
          <DetailPane
            paneRef={subRef}
            row={activeRow}
            source={section.source}
            schemas={schemas}
            levels={levels}
            depth={depth + 1}
            hidden={hidden}
            tab={subTab}
            onTab={onSubTab}
            onBack={() => focusPane(gridRef.current)}
            onHide={() => {
              setShowSub(false);
              focusPane(gridRef.current);
            }}
          />
        </div>
      )}
    </div>
  );
}
