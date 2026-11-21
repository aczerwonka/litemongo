import { useMemo, useState } from 'react';
import type { CollectionSchema, EjsonDoc, MasterDetailNode, RelationLevel } from '../types';
import type { DistinctScan } from './DistinctPopover';
import { DocTree } from './DocTree';
import { Grid, rootSource, type GridRow, type TableSource } from './Grid';
import { sectionId, sectionsFor, type Section } from './MasterDetailView';
import { Dropdown } from './ui';
import { CodeBadge } from './values';

/**
 * Nested Tabular View (table-in-table): every master row unfolds in place into
 * the tables of its details — one block per linked collection, embedded array
 * or (opt-in) embedded sub-document — and every detail row unfolds into its own
 * details again. Everything shown was already fetched by the batched $in engine.
 *
 * Linked collections (⛓, green, indented), embedded arrays (▤, blue) and
 * embedded objects (◇, violet) are styled apart. The "Details" picker
 * switches any of them on or off; Levels switch a whole level.
 */

const MAX_DEPTH = 4;

/** Guide rule per level, drawn down the left of a row's unfolded details. */
const LEVEL_RULE: Record<number, string> = {
  2: 'border-zinc-600',
  3: 'border-zinc-500',
  4: 'border-zinc-400',
};

const KIND_STYLE = {
  relation: {
    frame: 'border-emerald-800',
    head: 'bg-emerald-950 text-emerald-200 hover:bg-emerald-900',
    icon: '⛓',
    tag: 'Linked',
    chipOn: 'border-emerald-700 bg-emerald-950 text-emerald-200',
    text: 'text-emerald-300',
  },
  array: {
    frame: 'border-sky-800',
    head: 'bg-sky-950 text-sky-200 hover:bg-sky-900',
    icon: '▤',
    tag: 'Embedded',
    chipOn: 'border-sky-700 bg-sky-950 text-sky-200',
    text: 'text-sky-300',
  },
  object: {
    frame: 'border-violet-800',
    head: 'bg-violet-950 text-violet-200 hover:bg-violet-900',
    icon: '◇',
    tag: 'Object',
    chipOn: 'border-violet-700 bg-violet-950 text-violet-200',
    text: 'text-violet-300',
  },
} as const;

/** Chip text: sections inside a linked collection carry its name ("claims2 › items[]"). */
function chipLabel(k: SectionKind, root: string): string {
  return k.kind !== 'relation' && k.collection !== root ? `${k.collection} › ${k.label}` : k.label;
}

export interface NestedTableViewProps {
  collection: string;
  docs: EjsonDoc[];
  nodes: MasterDetailNode[] | null;
  schemas: Record<string, CollectionSchema>;
  levels: RelationLevel[];
  selection: Set<number>;
  onSelectionChange: (selection: Set<number>) => void;
  scanDistinct?: DistinctScan | undefined;
  hiddenSections: string[];
  onHiddenSectionsChange: (hidden: string[]) => void;
  shownSections?: string[];
  onShownSectionsChange?: (shown: string[]) => void;
  nestedUnfold?: boolean | null;
  onNestedUnfoldChange?: (open: boolean) => void;
  nestedJson?: boolean;
  onNestedJsonChange?: (on: boolean) => void;
}

interface SectionKind {
  id: string;
  kind: Section['kind'];
  label: string;
  /** Collection whose documents hold this section's rows (the linked one for ⛓ and below it). */
  collection: string;
  depth: number;
  /** Section the rows of this one live in (undefined at level 2). */
  parent: string | undefined;
  /** Rows (over the whole result) that have at least one item in it. */
  count: number;
}

/** Which detail sections are on: linked / arrays unless hidden, objects only when shown. */
interface Visibility {
  hidden: Set<string>;
  shown: Set<string>;
}
const isVisible = (v: Visibility, id: string, kind: Section['kind']) => (kind === 'object' ? v.shown.has(id) : !v.hidden.has(id));

/** How rows unfold: `json` lets rows without (shown) details unfold into their JSON tree; `all` = "Unfold all" was used. */
interface UnfoldOpts {
  visibility: Visibility;
  json: boolean;
  all: boolean;
}

/** Does this row have at least one switched-on detail section with something in it? */
function hasDetails(row: GridRow, source: TableSource, schemas: Record<string, CollectionSchema>, levels: RelationLevel[], v: Visibility): boolean {
  return sectionsFor(row, source, schemas, levels, { objects: true }).some((s) => s.rows.length > 0 && isVisible(v, sectionId(s), s.kind));
}

/** Every kind of detail section present in the result, parents before their children. */
function sectionKinds(rows: GridRow[], source: TableSource, schemas: Record<string, CollectionSchema>, levels: RelationLevel[]): SectionKind[] {
  const found = new Map<string, SectionKind>();
  const walk = (row: GridRow, src: TableSource, depth: number, parent: string | undefined) => {
    for (const s of sectionsFor(row, src, schemas, levels, { objects: true })) {
      const id = sectionId(s);
      const entry = found.get(id) ?? { id, kind: s.kind, label: s.label, collection: s.source.collection, depth, parent, count: 0 };
      if (s.rows.length > 0) entry.count += 1;
      found.set(id, entry);
      if (depth < MAX_DEPTH) for (const r of s.rows) walk(r, s.source, depth + 1, id);
    }
  };
  for (const row of rows) walk(row, source, 2, undefined);
  // Tree order: every section right after its parent.
  const all = [...found.values()];
  const out: SectionKind[] = [];
  const add = (parent: string | undefined) => {
    for (const k of all) {
      if (k.parent !== parent) continue;
      out.push(k);
      add(k.id);
    }
  };
  add(undefined);
  return out;
}

export function NestedTableView({
  collection,
  docs,
  nodes,
  schemas,
  levels,
  selection,
  onSelectionChange,
  scanDistinct,
  hiddenSections,
  onHiddenSectionsChange,
  shownSections = [],
  onShownSectionsChange,
  nestedUnfold = null,
  onNestedUnfoldChange,
  nestedJson = false,
  onNestedJsonChange,
}: NestedTableViewProps) {
  const rows = useMemo<GridRow[]>(() => docs.map((doc, index) => ({ index, doc, node: nodes?.[index] })), [docs, nodes]);
  const source = useMemo(() => rootSource(collection, schemas, docs[0]), [collection, schemas, docs]);
  const kinds = useMemo(() => sectionKinds(rows, source, schemas, levels), [rows, source, schemas, levels]);
  const [active, setActive] = useState<number | null>(null);
  // Bumping the key re-mounts the grid with every row folded / unfolded.
  // Unfold all / Fold all is remembered per tab; until used, small results start unfolded.
  const [unfoldAll, setUnfoldAll] = useState(nestedUnfold ?? docs.length <= 20);
  const [jsonLocal, setJsonLocal] = useState(nestedJson);
  const json = onNestedJsonChange ? nestedJson : jsonLocal;
  const setJson = onNestedJsonChange ?? setJsonLocal;
  const [generation, setGeneration] = useState(0);
  const visibility = useMemo<Visibility>(() => ({ hidden: new Set(hiddenSections), shown: new Set(shownSections) }), [hiddenSections, shownSections]);
  const byId = useMemo(() => new Map(kinds.map((k) => [k.id, k])), [kinds]);
  const opts = useMemo<UnfoldOpts>(() => ({ visibility, json, all: unfoldAll }), [visibility, json, unfoldAll]);
  const withDetails = (row: GridRow) => hasDetails(row, source, schemas, levels, visibility);

  const setAll = (open: boolean) => {
    setUnfoldAll(open);
    onNestedUnfoldChange?.(open);
    setGeneration((g) => g + 1);
  };

  /** Switch several sections at once (one store update each for hidden / shown). */
  const setMany = (list: SectionKind[], on: boolean) => {
    const objects = new Set(list.filter((k) => k.kind === 'object').map((k) => k.id));
    const others = new Set(list.filter((k) => k.kind !== 'object').map((k) => k.id));
    if (others.size) onHiddenSectionsChange(on ? hiddenSections.filter((id) => !others.has(id)) : [...new Set([...hiddenSections, ...others])]);
    if (objects.size && onShownSectionsChange)
      onShownSectionsChange(on ? [...new Set([...shownSections, ...objects])] : shownSections.filter((id) => !objects.has(id)));
  };
  const setVisible = (k: SectionKind, on: boolean) => setMany([k], on);

  /** Every section below `k` (its rows' sections, theirs, …). */
  const descendants = (k: SectionKind): SectionKind[] => {
    const out: SectionKind[] = [];
    const add = (id: string) => {
      for (const c of kinds) {
        if (c.parent !== id) continue;
        out.push(c);
        add(c.id);
      }
    };
    add(k.id);
    return out;
  };
  /**
   * Switch a whole group: off = every section in it; on = linked & arrays (objects
   * stay opt-in one by one, they are noisy). On when nothing in the group is on.
   */
  const toggleGroup = (group: SectionKind[]) => {
    const anyOn = group.some((k) => isVisible(visibility, k.id, k.kind));
    setMany(anyOn ? group : group.filter((k) => k.kind !== 'object'), !anyOn);
  };
  const depths = [...new Set(kinds.map((k) => k.depth))].sort((a, b) => a - b);

  /** Shown, and so is every section it lives in. */
  const reachable = (k: SectionKind): boolean => {
    for (let p = k.parent ? byId.get(k.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) {
      if (!isVisible(visibility, p.id, p.kind)) return false;
    }
    return true;
  };
  const on = kinds.filter((k) => isVisible(visibility, k.id, k.kind));

  return (
    <div className="flex h-full flex-col">
      <div className="relative z-[32] flex shrink-0 flex-wrap items-center gap-1.5 border-b border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-400">
        {kinds.length === 0 && <span className="text-zinc-600">No linked collections, arrays or objects</span>}
        {depths.length > 1 && (
          <span className="ml-1 inline-flex items-center gap-0.5" title="Switch a whole level on / off">
            <span className="text-zinc-500">Levels:</span>
            {depths.map((d) => {
              const group = kinds.filter((k) => k.depth === d);
              const onCount = group.filter((k) => isVisible(visibility, k.id, k.kind)).length;
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={onCount > 0}
                  onClick={() => toggleGroup(group)}
                  title={`Level ${d}: ${onCount} of ${group.length} on — click to switch ${onCount ? 'all off' : 'linked & arrays on'}`}
                  className={`rounded border px-1.5 py-0.5 font-mono ${
                    onCount === 0
                      ? 'border-zinc-700 text-zinc-600 line-through hover:text-zinc-300'
                      : onCount < group.length
                        ? 'border-zinc-600 text-zinc-300 hover:bg-zinc-800'
                        : 'border-zinc-500 bg-zinc-800 text-zinc-100 hover:bg-zinc-700'
                  }`}
                >
                  L{d}
                </button>
              );
            })}
          </span>
        )}
        {kinds.length > 0 && (
          <Dropdown
            label={<span>☰ Details: {on.length} of {kinds.length} shown</span>}
            title="Choose the linked collections, arrays and objects shown under every row"
            width={440}
          >
            <SectionPicker
              kinds={kinds}
              root={collection}
              visibility={visibility}
              reachable={reachable}
              canShowObjects={!!onShownSectionsChange}
              onToggle={setVisible}
              descendants={descendants}
              onToggleGroup={toggleGroup}
              onReset={() => {
                onHiddenSectionsChange([]);
                onShownSectionsChange?.([]);
              }}
            />
          </Dropdown>
        )}
        <label
          className="ml-auto flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-zinc-800 hover:text-zinc-100"
          title="Clicking a row without details (no linked documents, arrays or objects shown) unfolds its JSON document"
        >
          <input
            type="checkbox"
            checked={json}
            onChange={(e) => setJson(e.target.checked)}
          />
          {'{ }'} JSON for rows without details
        </label>
        <button type="button" className="rounded px-1.5 py-0.5 hover:bg-zinc-800 hover:text-zinc-100" onClick={() => setAll(true)}>
          ⊞ Unfold all
        </button>
        <button type="button" className="rounded px-1.5 py-0.5 hover:bg-zinc-800 hover:text-zinc-100" onClick={() => setAll(false)}>
          ⊟ Fold all
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {/*
          Fixed cover over the top edge of the scroll area. While scrolling, Chrome can move the content a frame
          ahead of the sticky table header, so a sliver of rows showed above it; this strip (the header's own
          top padding colour) never scrolls, so nothing shows through there.
        */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[31] h-1.5 bg-zinc-900" />
        <Grid
          key={generation}
          rows={rows}
          source={source}
          schemas={schemas}
          levels={levels}
          active={active}
          onActive={setActive}
          selection={selection}
          onSelectionChange={onSelectionChange}
          scanDistinct={scanDistinct}
          inlineTree
          separated
          defaultExpanded={unfoldAll && withDetails}
          canExpand={(row) => json || withDetails(row)}
          renderExpanded={(row) => <Details row={row} source={source} schemas={schemas} levels={levels} depth={2} opts={opts} />}
          maxColumns={30}
        />
      </div>
    </div>
  );
}

/**
 * Popup tree of every detail section: each one sits under the section its rows
 * live in (so `claims2 › items[]` hangs under ⛓ claims2). Changes apply live.
 */
function SectionPicker({
  kinds,
  root,
  visibility,
  reachable,
  canShowObjects,
  onToggle,
  descendants,
  onToggleGroup,
  onReset,
}: {
  kinds: SectionKind[];
  root: string;
  visibility: Visibility;
  reachable: (k: SectionKind) => boolean;
  canShowObjects: boolean;
  onToggle: (k: SectionKind, on: boolean) => void;
  descendants: (k: SectionKind) => SectionKind[];
  onToggleGroup: (group: SectionKind[]) => void;
  onReset: () => void;
}) {
  const [filter, setFilter] = useState('');
  const needle = filter.toLowerCase();
  const list = kinds.filter((k) => !needle || chipLabel(k, root).toLowerCase().includes(needle));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={filter}
          placeholder="Filter…"
          aria-label="Filter sections"
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-xs text-zinc-100 outline-none focus:border-emerald-600"
        />
        <button type="button" onClick={onReset} className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Linked & arrays on, objects off">
          Reset
        </button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
        {(['relation', 'array', 'object'] as const).map((kind) => (
          <span key={kind} className={KIND_STYLE[kind].text}>
            {KIND_STYLE[kind].icon} {kind === 'relation' ? 'linked collection' : kind === 'array' ? 'embedded array' : 'embedded object (off by default)'}
          </span>
        ))}
      </div>
      <ul className="border-t border-zinc-800 pt-1">
        {list.map((k) => {
          const style = KIND_STYLE[k.kind];
          const checked = isVisible(visibility, k.id, k.kind);
          const disabled = k.kind === 'object' && !canShowObjects;
          const ok = reachable(k);
          const below = descendants(k);
          const belowOn = below.filter((c) => isVisible(visibility, c.id, c.kind)).length;
          // Inside a linked collection, show the path relative to it.
          return (
            <li key={k.id} className="flex items-center gap-1">
              <label
                className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded py-0.5 pr-1 hover:bg-zinc-800 ${ok ? '' : 'opacity-50'} ${k.kind === 'relation' ? 'mt-1' : ''}`}
                style={{ paddingLeft: 4 + (k.depth - 2) * 16 }}
                title={ok ? `${chipLabel(k, root)} — in ${k.count} row${k.count === 1 ? '' : 's'}` : 'Shown only once the section it lives in is on'}
              >
                <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onToggle(k, e.target.checked)} />
                <span className={`w-3 shrink-0 text-center ${style.text}`}>{style.icon}</span>
                <span className={`truncate font-mono ${k.kind === 'relation' ? 'font-semibold text-emerald-200' : 'text-zinc-100'}`}>{k.label}</span>
                <span className="ml-auto shrink-0 text-[11px] text-zinc-500">
                  L{k.depth} · {k.count}
                </span>
              </label>
              {below.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onToggleGroup(below)}
                  title={`Everything under ${k.label} (${below.length} section${below.length === 1 ? '' : 's'}, ${belowOn} on): switch ${belowOn ? 'all off' : 'linked & arrays on'}`}
                  className={`w-14 shrink-0 rounded border px-1 text-center text-[10px] ${
                    belowOn ? 'border-zinc-600 text-zinc-300 hover:bg-zinc-800' : 'border-zinc-800 text-zinc-600 hover:text-zinc-300'
                  } ${k.kind === 'relation' ? 'mt-1' : ''}`}
                >
                  {belowOn ? 'sub: off' : 'sub: on'}
                </button>
              ) : (
                <span className="w-14 shrink-0" />
              )}
            </li>
          );
        })}
        {list.length === 0 && <li className="px-1 py-1 text-zinc-500">Nothing matches.</li>}
      </ul>
    </div>
  );
}

/** All detail tables of one row: linked collections (indented), embedded arrays, embedded objects. */
function Details({
  row,
  source,
  schemas,
  levels,
  depth,
  opts,
}: {
  row: GridRow;
  source: TableSource;
  schemas: Record<string, CollectionSchema>;
  levels: RelationLevel[];
  depth: number;
  opts: UnfoldOpts;
}) {
  const { visibility } = opts;
  const all = useMemo(() => sectionsFor(row, source, schemas, levels, { objects: true }), [row, source, schemas, levels]);
  const sections = all.filter((s) => isVisible(visibility, sectionId(s), s.kind));
  const badge = source.badgeField ? row.doc[source.badgeField] : undefined;
  const owner = source.display
    ? source.display.replace(/\[\]$/, `[${row.index}]`)
    : source.arrayPath.length
      ? `${source.arrayPath.join('.')}[${row.index}]`
      : source.collection;
  const hiddenCount = all.length - sections.length;

  if (sections.length === 0) {
    return (
      <div className="py-2 pl-8 font-mono text-[13px] leading-6">
        {hiddenCount > 0 && (
          <div className="mb-1 font-sans text-[11px] text-zinc-600">
            {hiddenCount} detail section{hiddenCount === 1 ? '' : 's'} off · choose them under “Details”
          </div>
        )}
        <DocTree doc={row.doc} node={row.node} collection={source.collection} schemas={source.arrayPath.length ? {} : schemas} defaultOpen />
      </div>
    );
  }
  const linked = sections.filter((s) => s.kind === 'relation');
  const embedded = sections.filter((s) => s.kind !== 'relation');
  const block = (s: Section) => <DetailBlock key={s.key} section={s} schemas={schemas} levels={levels} depth={depth} opts={opts} />;
  return (
    <div className="py-2 pr-2 pl-5">
      <div className={`flex flex-col gap-2 border-l-2 border-dashed pl-3 ${LEVEL_RULE[depth] ?? 'border-zinc-600'}`}>
        {embedded.map(block)}
        {linked.length > 0 && (
          // Linked documents are not part of this document: one step further right, with a link rule.
          <div className="ml-6 flex flex-col gap-2 border-l-2 border-emerald-800 pl-3">
            <div className="font-sans text-[11px] text-emerald-400">
              ⛓ linked to <span className="font-mono">{owner}</span>
              {badge !== undefined && (
                <span className="ml-1 align-middle">
                  <CodeBadge value={badge} title={source.badgeField} />
                </span>
              )}
            </div>
            {linked.map(block)}
          </div>
        )}
      </div>
    </div>
  );
}

function DetailBlock({
  section,
  schemas,
  levels,
  depth,
  opts,
}: {
  section: Section;
  schemas: Record<string, CollectionSchema>;
  levels: RelationLevel[];
  depth: number;
  opts: UnfoldOpts;
}) {
  const nested = depth < MAX_DEPTH;
  const withDetails = (row: GridRow) => nested && hasDetails(row, section.source, schemas, levels, opts.visibility);
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState<number | null>(null);
  const style = KIND_STYLE[section.kind];
  const count = section.kind === 'object' ? '' : `(${section.rows.length})`;
  return (
    <div className={`w-fit max-w-full min-w-96 overflow-hidden rounded-md border bg-zinc-950 shadow-sm ${style.frame}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex w-full items-center gap-1.5 px-2 py-1 text-left font-mono text-xs ${style.head}`}
      >
        <span className="w-3 opacity-70">{open ? '▾' : '▸'}</span>
        <span>{style.icon}</span>
        <span className="font-semibold">{section.label}</span>
        <span className="opacity-70">{count}</span>
        <span className="ml-auto flex items-center gap-1.5 pl-4 font-sans text-[10px] tracking-wide uppercase opacity-60">
          {style.tag} · L{depth}
        </span>
      </button>
      {open &&
        (section.rows.length === 0 ? (
          <div className="px-3 py-1.5 text-xs text-zinc-500">{section.kind === 'relation' ? 'Nothing linked.' : 'Empty array.'}</div>
        ) : (
          // No inner height cap: one scrollbar (the master grid's) for the whole tree.
          <div className="overflow-x-auto">
            <Grid
              rows={section.rows}
              source={section.source}
              schemas={schemas}
              levels={levels}
              active={active}
              onActive={setActive}
              inlineTree
              showBadge={section.kind !== 'object'}
              // Nested grids grow with their rows (no own vertical scroll), so no sticky header: nested sticky
              // layers inside the master scroller were drawn out of place over the master header while scrolling.
              stickyHeader={false}
              maxColumns={24}
              defaultExpanded={opts.all && withDetails}
              canExpand={(row) => opts.json || withDetails(row)}
              {...(nested
                ? {
                    renderExpanded: (row: GridRow) => (
                      <Details row={row} source={section.source} schemas={schemas} levels={levels} depth={depth + 1} opts={opts} />
                    ),
                  }
                : {})}
            />
          </div>
        ))}
    </div>
  );
}
