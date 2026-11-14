import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { classify } from '../lib/ejson';
import { fieldMapAt, orderFields } from '../lib/schema';
import { useUiStore } from '../store/useUiStore';
import { badgeFieldFor, useWorkspaceStore, type BadgeTarget } from '../store/useWorkspaceStore';
import type { CollectionSchema, EjsonDoc, MasterDetailNode, RelationLevel } from '../types';
import { DistinctButton, type DistinctScan } from './DistinctPopover';
import { DocTree } from './DocTree';
import { CodeBadge, Compact, compareEjson } from './values';

/**
 * Keyboard-navigable data grid shared by the Flat Table and every pane of the
 * Master-Detail view. Columns follow the documented schema first, then whatever
 * else the rows carry.
 *
 * Keys (grid focused): ↑/↓ or j/k move, Home/End, PageUp/PageDown, Space toggles
 * the selection checkbox, Enter / → opens the row (detail pane or inline tree),
 * ← / Esc goes back to the parent grid, [ and ] switch detail tabs.
 */

export interface GridRow {
  index: number;
  doc: EjsonDoc;
  node: MasterDetailNode | undefined;
}

/** Where a grid's rows come from. */
export interface TableSource {
  /** Collection whose schema documents these rows. */
  collection: string;
  /** Embedded array path inside that collection ([] for whole documents). */
  arrayPath: string[];
  badgeField: string | undefined;
  badgeTarget: BadgeTarget;
  /** Display path of these rows (e.g. `covers[]`, `covers[].deductible`); derived from arrayPath when absent. */
  display?: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return classify(v).kind === 'object';
}

export function autoBadge(sample: unknown): string | undefined {
  return isObj(sample) && typeof sample.code === 'string' ? 'code' : undefined;
}

/** Badge field shown for documents of a linked collection. */
export function relationBadge(
  collection: string,
  schemas: Record<string, CollectionSchema>,
  levels: RelationLevel[],
  sample: unknown,
): string | undefined {
  return (
    schemas[collection]?.displayBadgeField ??
    levels.find((l) => l.collection === collection)?.displayBadgeField ??
    autoBadge(sample)
  );
}

export function rootSource(collection: string, schemas: Record<string, CollectionSchema>, sample: unknown): TableSource {
  return {
    collection,
    arrayPath: [],
    badgeField: schemas[collection]?.displayBadgeField ?? autoBadge(sample),
    badgeTarget: { kind: 'collection', collection },
  };
}

export function arraySource(
  collection: string,
  arrayPath: string[],
  schemas: Record<string, CollectionSchema>,
  sample: unknown,
): TableSource {
  return {
    collection,
    arrayPath,
    badgeField: badgeFieldFor(schemas[collection], arrayPath, sample),
    badgeTarget: { kind: 'array', collection, path: arrayPath },
  };
}

export interface GridProps {
  rows: GridRow[];
  source: TableSource;
  schemas: Record<string, CollectionSchema>;
  levels: RelationLevel[];
  /** `index` of the highlighted row. */
  active: number | null;
  onActive: (index: number) => void;
  selection?: Set<number> | undefined;
  onSelectionChange?: ((selection: Set<number>) => void) | undefined;
  scanDistinct?: DistinctScan | undefined;
  /** Leading badge column with its field picker (default true). */
  showBadge?: boolean;
  /** Enter / click unfolds the row into a document tree below it. */
  inlineTree?: boolean;
  /** With `inlineTree`: what an unfolded row shows instead of its document tree. */
  renderExpanded?: ((row: GridRow) => ReactNode) | undefined;
  /** With `inlineTree`: start with every row unfolded (or those the function picks). */
  defaultExpanded?: boolean | ((row: GridRow) => boolean);
  /** With `inlineTree`: which rows can unfold at all (default: every row); others get no caret. */
  canExpand?: ((row: GridRow) => boolean) | undefined;
  /** Master rows: stronger rows with a separator between one row's details and the next row. */
  separated?: boolean;
  /** Header sticks to the top while scrolling (default true). Off for grids that never scroll vertically themselves. */
  stickyHeader?: boolean;
  maxColumns?: number;
  onEnter?: () => void;
  onBack?: () => void;
  onCycleTab?: (direction: 1 | -1) => void;
}

const PAGE = 10;

export function Grid({
  rows,
  source,
  schemas,
  levels,
  active,
  onActive,
  selection,
  onSelectionChange,
  scanDistinct,
  showBadge = true,
  inlineTree = false,
  renderExpanded,
  defaultExpanded = false,
  canExpand,
  separated = false,
  stickyHeader = true,
  maxColumns = 40,
  onEnter,
  onBack,
  onCycleTab,
}: GridProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const allIndexes = () =>
    new Set(
      defaultExpanded
        ? rows.filter((r) => (typeof defaultExpanded === 'function' ? defaultExpanded(r) : !canExpand || canExpand(r))).map((r) => r.index)
        : [],
    );
  const [expanded, setExpanded] = useState<Set<number>>(allIndexes);
  const containerRef = useRef<HTMLDivElement>(null);
  const theadRef = useRef<HTMLTableSectionElement>(null);
  // Unfolded master rows stick right below the header while their details scroll by.
  const [headHeight, setHeadHeight] = useState(0);
  useLayoutEffect(() => {
    // 1px overlap under the header (it sits above): no sub-pixel gap for content to show through.
    if (separated && theadRef.current) setHeadHeight(Math.floor(theadRef.current.getBoundingClientRect().height) - 1);
  });
  const setBadgeField = useWorkspaceStore((s) => s.setBadgeField);
  const openLink = useUiStore((s) => s.openLink);
  const schema = schemas[source.collection];
  const documented = useMemo(() => fieldMapAt(schema, source.arrayPath), [schema, source.arrayPath]);
  const docs = useMemo(() => rows.map((r) => r.doc), [rows]);
  const selectable = !!selection && !!onSelectionChange;

  // Re-applied when the rows change or unfold-all is switched, not on every new callback.
  useEffect(() => setExpanded(allIndexes()), [rows, !!defaultExpanded]);

  const { fields, badgeOptions, childCollections } = useMemo(() => {
    const observed: string[] = [];
    const seen = new Set<string>();
    const scalarish = new Set<string>();
    for (const doc of docs) {
      for (const [k, v] of Object.entries(doc)) {
        if (!seen.has(k)) {
          seen.add(k);
          observed.push(k);
        }
        const kind = classify(v).kind;
        if (kind !== 'object' && kind !== 'array' && kind !== 'null') scalarish.add(k);
      }
    }
    const ordered = orderFields(observed, documented);
    return {
      fields: ordered.slice(0, maxColumns),
      badgeOptions: ordered.filter((k) => scalarish.has(k)),
      childCollections: [...new Set(rows.flatMap((r) => Object.keys(r.node?.children ?? {})))],
    };
  }, [docs, rows, documented, maxColumns]);

  const toggleSelected = (index: number) => {
    if (!selection || !onSelectionChange) return;
    const next = new Set(selection);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onSelectionChange(next);
  };

  const columns = useMemo<ColumnDef<GridRow>[]>(() => {
    const cols: ColumnDef<GridRow>[] = [];
    if (selection && onSelectionChange) {
      const allSelected = rows.length > 0 && selection.size === rows.length;
      cols.push({
        id: '__select',
        enableSorting: false,
        header: () => (
          <input
            type="checkbox"
            aria-label="Select all"
            checked={allSelected}
            onChange={() => onSelectionChange(allSelected ? new Set() : new Set(rows.map((r) => r.index)))}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label="Select row"
            checked={selection.has(row.original.index)}
            onClick={(e) => e.stopPropagation()}
            onChange={() => {
              const next = new Set(selection);
              if (next.has(row.original.index)) next.delete(row.original.index);
              else next.add(row.original.index);
              onSelectionChange(next);
            }}
          />
        ),
      });
    }
    if (showBadge) {
      cols.push({
        id: '__badge',
        accessorFn: (r) => (source.badgeField ? r.doc[source.badgeField] : undefined),
        sortingFn: (a, b, id) => compareEjson(a.getValue(id), b.getValue(id)),
        header: () => (
          <select
            // No title tooltip: it popped up over the grid whenever scrolling left the cursor on the header.
            aria-label="Badge field"
            className="rounded border border-indigo-800 bg-indigo-950 px-1 py-0 font-mono text-[11px] font-normal text-indigo-200"
            value={source.badgeField ?? ''}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setBadgeField(source.badgeTarget, e.target.value || null)}
          >
            <option value="">badge: none</option>
            {[...new Set([...(source.badgeField ? [source.badgeField] : []), ...badgeOptions])].map((f) => (
              <option key={f} value={f}>
                badge: {f}
              </option>
            ))}
          </select>
        ),
        cell: ({ getValue }) => {
          const v = getValue();
          return source.badgeField && v !== undefined ? <CodeBadge value={v} title={source.badgeField} /> : null;
        },
      });
    }
    for (const child of childCollections) {
      cols.push({
        id: `__child_${child}`,
        header: `⛓ ${child}`,
        accessorFn: (r) => r.node?.children[child]?.length ?? 0,
        cell: ({ row, getValue }) => {
          const list = row.original.node?.children[child] ?? [];
          const field = relationBadge(child, schemas, levels, list[0]?.doc);
          return (
            <span className="inline-flex items-center gap-1">
              <span className={list.length ? 'text-emerald-400' : 'text-zinc-600'}>{getValue<number>()}</span>
              {field && list.slice(0, 3).map((n, i) => <CodeBadge key={i} value={n.doc[field]} title={`${child}.${field}`} />)}
              {field && list.length > 3 && <span className="text-xs text-zinc-500">+{list.length - 3}</span>}
            </span>
          );
        },
      });
    }
    for (const field of fields) {
      const def = documented?.[field];
      const path = [...source.arrayPath, field].join('.');
      const hint = def
        ? [def.type, def.description, def.enum?.length ? `Values: ${def.enum.join(', ')}` : ''].filter(Boolean).join(' — ')
        : 'Not documented in the schema';
      cols.push({
        id: field,
        accessorFn: (r) => r.doc[field],
        sortingFn: (a, b, id) => compareEjson(a.getValue(id), b.getValue(id)),
        header: () => (
          <span className="group/th inline-flex items-center" title={hint}>
            <span className={def ? '' : 'font-normal text-zinc-400 italic'}>{field}</span>
            <span className="opacity-30 group-hover/th:opacity-100 focus-within:opacity-100">
              <DistinctButton path={field} docs={docs} scan={source.arrayPath.length === 0 ? scanDistinct : undefined} />
              <button
                type="button"
                title={`Link another collection on ${source.collection}.${path}`}
                aria-label={`Link another collection on ${path}`}
                className="ml-0.5 rounded px-0.5 text-[11px] font-normal text-zinc-600 hover:text-emerald-300"
                onClick={(e) => {
                  e.stopPropagation();
                  openLink({ parentCollection: source.collection, localField: path });
                }}
              >
                ⛓
              </button>
            </span>
          </span>
        ),
        cell: ({ getValue }) => {
          const v = getValue();
          return v === undefined ? (
            <span className="text-zinc-700">—</span>
          ) : (
            <Compact value={v} schema={schema} path={[...source.arrayPath, field]} />
          );
        },
      });
    }
    return cols;
  }, [
    selection,
    onSelectionChange,
    rows,
    showBadge,
    source,
    badgeOptions,
    childCollections,
    fields,
    docs,
    schema,
    schemas,
    levels,
    documented,
    scanDistinct,
    setBadgeField,
    openLink,
  ]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const visibleRows = table.getRowModel().rows;

  // Keep the highlighted row in view while moving with the keyboard.
  useEffect(() => {
    if (active === null) return;
    containerRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const toggleExpanded = (index: number) => {
    const row = rows.find((r) => r.index === index);
    if (canExpand && row && !canExpand(row) && !expanded.has(index)) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'SELECT') return;
    const onControl = target !== e.currentTarget && ['BUTTON', 'INPUT'].includes(target.tagName);
    const order = visibleRows.map((r) => r.original.index);
    const pos = active === null ? -1 : order.indexOf(active);
    const go = (p: number) => {
      const index = order[Math.max(0, Math.min(order.length - 1, p))];
      if (index !== undefined) onActive(index);
    };
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        go(pos + 1);
        break;
      case 'ArrowUp':
      case 'k':
        go(pos - 1);
        break;
      case 'PageDown':
        go(pos + PAGE);
        break;
      case 'PageUp':
        go(pos - PAGE);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(order.length - 1);
        break;
      case ' ':
        if (onControl || active === null || !selectable) return;
        toggleSelected(active);
        break;
      case 'Enter':
        if (onControl) return;
        if (inlineTree && active !== null) toggleExpanded(active);
        else onEnter?.();
        break;
      case 'ArrowRight':
        if (!onEnter) return;
        onEnter();
        break;
      case 'ArrowLeft':
      case 'Escape':
        if (!onBack) return;
        onBack();
        break;
      case '[':
      case ']':
        if (!onCycleTab) return;
        onCycleTab(e.key === ']' ? 1 : -1);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const label = source.arrayPath.length ? `${source.collection}.${source.arrayPath.join('.')}` : source.collection;

  return (
    <div
      ref={containerRef}
      data-grid
      tabIndex={0}
      role="grid"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="group/grid h-full overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-emerald-600/70 focus-visible:ring-inset"
    >
      <table
        // The master grid uses separate borders: collapsed borders stay behind when a cell sticks, leaving see-through gaps.
        className={`w-max min-w-full font-mono text-[13px] ${separated ? 'border-separate border-spacing-0' : 'border-collapse'}`}
      >
        <thead ref={theadRef}>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th
                  key={h.id}
                  onClick={h.column.getToggleSortingHandler()}
                  // Sticky on each <th>, not on <thead>: Safari draws a sticky <thead> offset and ignores its z-index,
                  // letting scrolled rows show above / through the header. The bottom rule is an inset shadow because
                  // borders don't travel with sticky cells. z: above the master grid's sticky rows (z-20).
                  className={`bg-zinc-900 px-2 py-1.5 text-left font-semibold whitespace-nowrap text-zinc-300 shadow-[inset_0_-1px_0_var(--color-zinc-800)] ${
                    stickyHeader ? `sticky top-0 ${separated ? 'z-30' : 'z-10'}` : ''
                  } ${h.column.getCanSort() ? 'cursor-pointer select-none hover:text-zinc-50' : ''}`}
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? ''}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <BodyGroup on={!separated}>
          {visibleRows.map((row) => {
            const index = row.original.index;
            const isActive = index === active;
            const isSelected = selection?.has(index) ?? false;
            const isOpen = inlineTree && expanded.has(index);
            const expandable = inlineTree && (!canExpand || canExpand(row.original) || isOpen);
            return (
              <BodyGroup key={row.id} on={separated}>
                <tr
                  data-row={index}
                  aria-selected={isActive}
                  onClick={() => {
                    onActive(index);
                    if (inlineTree) toggleExpanded(index);
                  }}
                  className={`scroll-mt-8 border-b border-zinc-900 ${expandable ? 'cursor-pointer' : 'cursor-default'} ${
                    separated ? 'font-medium' : ''
                  } ${
                    isActive
                      ? 'bg-zinc-800 shadow-[inset_2px_0_0_var(--color-emerald-500)]'
                      : isSelected
                        ? 'bg-emerald-950'
                        : separated
                          ? isOpen
                            ? 'bg-zinc-800 hover:bg-zinc-700/60'
                            : 'bg-zinc-900 hover:bg-zinc-800'
                          : isOpen
                            ? 'bg-zinc-900 hover:bg-zinc-800/70'
                            : 'hover:bg-zinc-900'
                  }`}
                >
                  {row.getVisibleCells().map((cell, i) => (
                    <td
                      key={cell.id}
                      className={`max-w-96 truncate px-2 align-top whitespace-nowrap ${separated ? 'border-t-2 border-b border-t-zinc-600 border-b-zinc-800 bg-inherit py-1.5' : 'py-1'} ${
                        separated && isOpen ? 'sticky z-20' : ''
                      } ${separated && i === 0 ? 'shadow-[inset_4px_0_0_var(--color-emerald-600)]' : ''}`}
                      style={separated && isOpen ? { top: headHeight } : undefined}
                    >
                      {i === 0 && canExpand && (
                        <span className="mr-1 inline-block w-3 text-zinc-500" aria-hidden>
                          {expandable ? (isOpen ? '▾' : '▸') : ''}
                        </span>
                      )}
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
                {isOpen && (
                  <tr className="bg-zinc-950">
                    <td
                      colSpan={row.getVisibleCells().length}
                      className={`${renderExpanded ? 'p-0' : 'px-4 py-2 leading-6'} ${separated ? 'border-b-2 border-zinc-600 shadow-[inset_4px_0_0_var(--color-emerald-600)]' : ''}`}
                    >
                      {renderExpanded ? (
                        // Nested grids handle their own clicks; don't fold this row.
                        <div onClick={(e) => e.stopPropagation()}>{renderExpanded(row.original)}</div>
                      ) : (
                        <DocTree doc={row.original.doc} node={row.original.node} collection={source.collection} schemas={schemas} defaultOpen />
                      )}
                    </td>
                  </tr>
                )}
              </BodyGroup>
            );
          })}
        </BodyGroup>
      </table>
    </div>
  );
}

/**
 * A <tbody> when `on`, else just its children. The master grid gives every row
 * (with its details) its own <tbody>, so a stuck master row lets go once its
 * details have scrolled past.
 */
function BodyGroup({ on, children }: { on: boolean; children: ReactNode }) {
  return on ? <tbody>{children}</tbody> : <>{children}</>;
}
