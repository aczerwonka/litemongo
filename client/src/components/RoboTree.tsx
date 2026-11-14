import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { classify } from '../lib/ejson';
import { badgeFieldFor } from '../store/useWorkspaceStore';
import type { CollectionSchema, EjsonDoc, MasterDetailNode, RelationLevel } from '../types';
import { relationBadge } from './Grid';
import { Dropdown } from './ui';
import { CodeBadge, Compact, Scalar } from './values';

/**
 * Robo 3T–style tree: one row per document / field in Key · Value · Type
 * columns. Linked documents hang under their parent as "⛓ collection" groups,
 * so every relation level sits one step further to the right; sibling links of
 * the same parent are sibling groups at the same indentation.
 *
 * Synchronized unfold: every row knows its path from its root document
 * (field → list item → link → linked document …), so what is unfolded in one
 * document can be replayed on all the others — once ("Apply to all", =) or
 * live while "Sync unfold" is on. List items are matched by the same values
 * of chosen key fields (the badge field, e.g. `code`, and / or custom ones such
 * as `role`), by position, or all of them.
 *
 * Keys: ↑/↓ move, → unfolds (or steps in), ← folds (or steps out), Space selects
 * a root document, * unfolds every document and link under the current row,
 * = applies the current document's unfolds to every document.
 */

export interface RoboTreeProps {
  collection: string;
  docs: EjsonDoc[];
  nodes: MasterDetailNode[] | null;
  schemas: Record<string, CollectionSchema>;
  levels: RelationLevel[];
  selection: Set<number>;
  onSelectionChange: (selection: Set<number>) => void;
}

type RowKind = 'doc' | 'field' | 'relation';

/** One step of a row's path below its root document. */
type Step =
  | { t: 'field'; k: string }
  /** List item: its position, value and badge field (e.g. code) identify it across documents. */
  | { t: 'item'; i: number; item: unknown; badgeField: string | undefined }
  | { t: 'rel'; c: string }
  | { t: 'reldoc'; j: number; item: unknown; badgeField: string | undefined };

/**
 * How list items (and linked documents) are matched when unfolds are replayed:
 * by the same values of the chosen key fields, by position, or all of them.
 */
export interface ItemMatch {
  mode: 'values' | 'index' | 'all';
  /** Same value of the badge field (`code` unless configured otherwise). */
  code: boolean;
  /** Same value of these fields, e.g. "role" (comma-separated). */
  custom: boolean;
  customFields: string;
}

const DEFAULT_MATCH: ItemMatch = { mode: 'values', code: true, custom: false, customFields: '' };

function customFieldList(m: ItemMatch): string[] {
  return m.custom
    ? m.customFields
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
    : [];
}

function matchLabel(m: ItemMatch): string {
  if (m.mode === 'index') return 'same position';
  if (m.mode === 'all') return 'all items';
  const keys = [...(m.code ? ['code'] : []), ...customFieldList(m)];
  return keys.length ? `same ${keys.join(', ')}` : 'same position';
}

/** Value of a dotted path inside a sub-document. */
function valueAt(v: unknown, path: string): unknown {
  let cur = v;
  for (const k of path.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Does `candidate` (at position `i`) correspond to the source item? With
 * "same values" only the chosen key fields the source item actually has are
 * compared; if it has none of them, `fallback` decides (position for list
 * items, everything for linked documents).
 */
function sameItem(
  m: ItemMatch,
  source: { i: number; item: unknown; badgeField: string | undefined },
  candidate: unknown,
  i: number,
  fallback: 'index' | 'all',
): boolean {
  if (m.mode === 'all') return true;
  if (m.mode === 'index') return i === source.i;
  const keys = new Set<string>(customFieldList(m));
  if (m.code) keys.add(source.badgeField ?? 'code');
  const present = [...keys].filter((k) => valueAt(source.item, k) !== undefined);
  if (present.length === 0) return fallback === 'all' || i === source.i;
  return present.every((k) => badgeText(valueAt(candidate, k)) === badgeText(valueAt(source.item, k)));
}

interface TreeRow {
  id: string;
  parentId: string | null;
  depth: number;
  kind: RowKind;
  /** Relation level of the document this row belongs to (1 = queried collection). */
  level: number;
  expandable: boolean;
  key: ReactNode;
  value: ReactNode;
  type: string;
  /** Root document this row lives in, and the path to the row from there. */
  root: number;
  steps: Step[];
  /** Index of the root document (doc rows at level 1 only), for selection. */
  rootIndex?: number;
  /** Ids of documents and links below this row (for "*" unfold). */
  structural?: string[];
}

/** Accent per relation level: left rule + key colour. */
const LEVEL_STYLE = [
  { rule: '', key: 'text-zinc-100' },
  { rule: '', key: 'text-zinc-100' },
  { rule: 'shadow-[inset_3px_0_0_var(--color-emerald-600)]', key: 'text-emerald-300' },
  { rule: 'shadow-[inset_3px_0_0_var(--color-sky-600)]', key: 'text-sky-300' },
  { rule: 'shadow-[inset_3px_0_0_var(--color-violet-600)]', key: 'text-violet-300' },
];

function fieldCount(n: number): string {
  return `{ ${n} field${n === 1 ? '' : 's'} }`;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => classify(v).kind === 'object';
const badgeText = (v: unknown) => JSON.stringify(v ?? null);

interface BuildCtx {
  expanded: Set<string>;
  schemas: Record<string, CollectionSchema>;
  levels: RelationLevel[];
  out: TreeRow[];
  root: number;
}

function pushValue(
  ctx: BuildCtx,
  id: string,
  parentId: string,
  depth: number,
  level: number,
  name: ReactNode,
  value: unknown,
  schema: CollectionSchema | undefined,
  path: string[],
  steps: Step[],
) {
  const c = classify(value);
  const base = { id, parentId, depth, kind: 'field' as const, level, root: ctx.root, steps, key: name };
  if (c.kind !== 'object' && c.kind !== 'array') {
    ctx.out.push({ ...base, expandable: false, value: <Scalar value={value} />, type: c.type });
    return;
  }
  const open = ctx.expanded.has(id);
  if (c.kind === 'array') {
    const items = value as unknown[];
    ctx.out.push({
      ...base,
      expandable: items.length > 0,
      value: open ? (
        <span className="text-zinc-500">{`[ ${items.length} element${items.length === 1 ? '' : 's'} ]`}</span>
      ) : (
        <Compact value={value} schema={schema} path={path} />
      ),
      type: 'Array',
    });
    if (!open) return;
    const badge = badgeFieldFor(schema, path, items[0]);
    items.forEach((v, i) => {
      const step: Step = { t: 'item', i, item: v, badgeField: badge };
      let label: ReactNode = `[${i}]`;
      if (badge && isPlainObject(v) && v[badge] !== undefined) {
        label = (
          <span className="inline-flex items-center gap-1.5">
            [{i}] <CodeBadge value={v[badge]} title={badge} />
          </span>
        );
      }
      // Array elements share their parent's schema path (covers[] -> covers).
      pushValue(ctx, `${id}.[${i}]`, id, depth + 1, level, label, v, schema, path, [...steps, step]);
    });
    return;
  }
  const entries = Object.entries(value as object);
  ctx.out.push({
    ...base,
    expandable: entries.length > 0,
    value: open ? <span className="text-zinc-500">{fieldCount(entries.length)}</span> : <Compact value={value} schema={schema} path={path} />,
    type: 'Object',
  });
  if (!open) return;
  for (const [k, v] of entries) {
    pushValue(ctx, `${id}.${k}`, id, depth + 1, level, k, v, schema, [...path, k], [...steps, { t: 'field', k }]);
  }
}

function pushDoc(
  ctx: BuildCtx,
  id: string,
  parentId: string | null,
  depth: number,
  level: number,
  ordinal: number,
  doc: EjsonDoc,
  node: MasterDetailNode | undefined,
  collection: string,
  badgeField: string | undefined,
  steps: Step[],
  rootIndex?: number,
) {
  const schema = ctx.schemas[collection];
  const open = ctx.expanded.has(id);
  const children = Object.entries(node?.children ?? {});
  const fields = Object.entries(doc);
  const badge = badgeField ? doc[badgeField] : undefined;
  const structural: string[] = [];
  const collect = (docId: string, n: MasterDetailNode | undefined) => {
    for (const [c, list] of Object.entries(n?.children ?? {})) {
      const relId = `${docId}/⛓${c}`;
      structural.push(relId);
      list.forEach((child, j) => {
        structural.push(`${relId}/${j}`);
        collect(`${relId}/${j}`, child);
      });
    }
  };
  collect(id, node);
  ctx.out.push({
    id,
    parentId,
    depth,
    kind: 'doc',
    level,
    expandable: true,
    root: ctx.root,
    steps,
    key: (
      <span className="inline-flex items-center gap-1.5">
        <span>({ordinal})</span>
        {doc._id !== undefined && <Scalar value={doc._id} />}
        {badge !== undefined && <CodeBadge value={badge} title={badgeField} />}
      </span>
    ),
    value: (
      <span className="inline-flex items-center gap-2 text-zinc-500">
        {fieldCount(fields.length)}
        {children.map(([c, list]) => (
          <span key={c} className="text-xs">
            ⛓ {c} <span className={list.length ? 'text-emerald-400' : 'text-zinc-600'}>{list.length}</span>
          </span>
        ))}
      </span>
    ),
    type: level === 1 ? 'Document' : `Document · ${collection}`,
    ...(rootIndex !== undefined ? { rootIndex } : {}),
    structural,
  });
  if (!open) return;
  for (const [k, v] of fields) pushValue(ctx, `${id}.${k}`, id, depth + 1, level, k, v, schema, [k], [...steps, { t: 'field', k }]);
  for (const [childCollection, list] of children) {
    const relId = `${id}/⛓${childCollection}`;
    const relSteps: Step[] = [...steps, { t: 'rel', c: childCollection }];
    const relOpen = ctx.expanded.has(relId);
    const childBadge = relationBadge(childCollection, ctx.schemas, ctx.levels, list[0]?.doc);
    const link = ctx.levels.find((l) => l.collection === childCollection);
    ctx.out.push({
      id: relId,
      parentId: id,
      depth: depth + 1,
      kind: 'relation',
      level: level + 1,
      expandable: list.length > 0,
      root: ctx.root,
      steps: relSteps,
      key: (
        <span className="inline-flex items-center gap-1.5 font-semibold">
          <span className="text-emerald-400">⛓</span> {childCollection}
        </span>
      ),
      value: (
        <span className="inline-flex flex-wrap items-center gap-1 text-zinc-400">
          {list.length} document{list.length === 1 ? '' : 's'}
          {!relOpen && childBadge && list.slice(0, 6).map((n, i) => <CodeBadge key={i} value={n.doc[childBadge]} title={childBadge} />)}
          {!relOpen && childBadge && list.length > 6 && <span className="text-xs text-zinc-500">+{list.length - 6}</span>}
        </span>
      ),
      type: link ? `Link · ${link.foreignField} = ${link.parentCollection ?? collection}.${link.localField}` : 'Link',
    });
    if (!relOpen) continue;
    list.forEach((child, j) =>
      pushDoc(ctx, `${relId}/${j}`, relId, depth + 2, level + 1, j + 1, child.doc, child, childCollection, childBadge, [
        ...relSteps,
        { t: 'reldoc', j, item: child.doc, badgeField: childBadge },
      ]),
    );
  }
}

/**
 * Rows of root document `root` matching `steps`: `hits` are the matching rows
 * themselves, `path` also holds every row on the way (which must be unfolded
 * for a hit to show).
 */
function resolveSteps(
  root: number,
  doc: EjsonDoc,
  node: MasterDetailNode | undefined,
  steps: Step[],
  match: ItemMatch,
): { path: string[]; hits: string[] } {
  const path: string[] = [];
  const hits: string[] = [];
  const walk = (id: string, value: unknown, n: MasterDetailNode | undefined, rest: Step[]) => {
    path.push(id);
    const [step, ...tail] = rest;
    if (!step) {
      hits.push(id);
      return;
    }
    switch (step.t) {
      case 'field':
        if (isPlainObject(value) && step.k in value) walk(`${id}.${step.k}`, value[step.k], undefined, tail);
        return;
      case 'item': {
        if (!Array.isArray(value)) return;
        value.forEach((item, i) => {
          if (sameItem(match, step, item, i, 'index')) walk(`${id}.[${i}]`, item, undefined, tail);
        });
        return;
      }
      case 'rel': {
        const list = n?.children[step.c];
        if (!list) return;
        const relId = `${id}/⛓${step.c}`;
        const [next, ...after] = tail;
        if (!next) {
          walk(relId, undefined, undefined, []);
          return;
        }
        path.push(relId);
        if (next.t !== 'reldoc') return;
        // Linked documents differ per parent: without matching key values, all of them.
        list.forEach((child, j) => {
          if (sameItem(match, { ...next, i: next.j }, child.doc, j, 'all')) walk(`${relId}/${j}`, child.doc, child, after);
        });
        return;
      }
      case 'reldoc':
        return;
    }
  };
  walk(`r${root}`, doc, node, steps);
  return { path, hits };
}

export function RoboTree({ collection, docs, nodes, schemas, levels, selection, onSelectionChange }: RoboTreeProps) {
  const badgeField = useMemo(() => relationBadge(collection, schemas, [], docs[0]), [collection, schemas, docs]);
  const initial = () => new Set(docs.length <= 5 ? docs.map((_, i) => `r${i}`) : []);
  const [expanded, setExpanded] = useState<Set<string>>(initial);
  const [cursor, setCursor] = useState<string | null>(docs.length ? 'r0' : null);
  const [keyWidth, setKeyWidth] = useState(440);
  const [sync, setSync] = useState(false);
  const [match, setMatch] = useState<ItemMatch>(DEFAULT_MATCH);
  const [notice, setNotice] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpanded(initial());
    setCursor(docs.length ? 'r0' : null);
  }, [docs, nodes]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const rows = useMemo(() => {
    const ctx: BuildCtx = { expanded, schemas, levels, out: [], root: 0 };
    docs.forEach((doc, i) => {
      ctx.root = i;
      pushDoc(ctx, `r${i}`, null, 0, 1, i + 1, doc, nodes?.[i], collection, badgeField, [], i);
    });
    return ctx.out;
  }, [docs, nodes, expanded, schemas, levels, collection, badgeField]);

  const byId = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows]);
  const cursorRow = cursor === null ? undefined : rows[byId.get(cursor) ?? -1];

  useEffect(() => {
    if (cursor === null) return;
    containerRef.current?.querySelector(`[data-tree-row="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  /** The rows matching `row`'s path in every document. */
  const everywhere = (row: TreeRow) => {
    const path: string[] = [];
    const hits: string[] = [];
    docs.forEach((doc, i) => {
      const r = resolveSteps(i, doc, nodes?.[i], row.steps, match);
      path.push(...r.path);
      hits.push(...r.hits);
    });
    return { path, hits };
  };

  const toggle = (row: TreeRow, open?: boolean) => {
    const opening = open ?? !expanded.has(row.id);
    const targets = sync ? everywhere(row) : { path: [row.id], hits: [row.id] };
    setExpanded((prev) => {
      const next = new Set(prev);
      // Unfolding opens the way to every match; folding closes the matches only.
      if (opening) for (const id of targets.path) next.add(id);
      else for (const id of [row.id, ...targets.hits]) next.delete(id);
      return next;
    });
  };

  /** Replay the unfolds of document `root` on every document ("apply view to all"). */
  const applyToAll = (root: number) => {
    const source = rows.filter((r) => r.root === root && r.expandable && expanded.has(r.id));
    if (source.length === 0) {
      setNotice(`Unfold something in document (${root + 1}) first`);
      return;
    }
    const next = new Set<string>();
    for (const r of source) {
      next.add(r.id);
      for (const id of everywhere(r).path) next.add(id);
    }
    setExpanded(next);
    setNotice(`Unfolded ${docs.length} documents like (${root + 1}) · list items: ${matchLabel(match)}`);
  };

  const unfoldStructure = (row: TreeRow) => setExpanded((prev) => new Set([...prev, row.id, ...(row.structural ?? [])]));

  const unfoldAllLinks = () =>
    setExpanded(new Set(rows.filter((r) => r.kind === 'doc' && r.level === 1).flatMap((r) => [r.id, ...(r.structural ?? [])])));

  const toggleSelect = (index: number) => {
    const next = new Set(selection);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onSelectionChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || ['INPUT', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
    const pos = cursor === null ? -1 : (byId.get(cursor) ?? -1);
    const row = rows[pos];
    const go = (p: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, p))];
      if (next) setCursor(next.id);
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
        go(pos + 15);
        break;
      case 'PageUp':
        go(pos - 15);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(rows.length - 1);
        break;
      case 'ArrowRight':
        if (!row?.expandable) return;
        if (!expanded.has(row.id)) toggle(row, true);
        else go(pos + 1);
        break;
      case 'ArrowLeft':
        if (!row) return;
        if (row.expandable && expanded.has(row.id)) toggle(row, false);
        else if (row.parentId) setCursor(row.parentId);
        break;
      case 'Enter':
        if (!row?.expandable) return;
        toggle(row);
        break;
      case ' ':
        if (row?.rootIndex === undefined) return;
        toggleSelect(row.rootIndex);
        break;
      case '*':
        if (!row || row.kind === 'field') return;
        unfoldStructure(row);
        break;
      case '=':
        if (!row) return;
        applyToAll(row.root);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = keyWidth;
    const move = (ev: PointerEvent) => setKeyWidth(Math.max(160, Math.min(1200, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const hasLinks = !!nodes?.some((n) => Object.keys(n.children).length > 0);
  const grid = { gridTemplateColumns: `${keyWidth}px minmax(16rem, 1fr) 14rem` };
  const toolBtn = 'rounded px-1.5 py-0.5 hover:bg-zinc-800 hover:text-zinc-100';

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-400">
        <button
          type="button"
          aria-pressed={sync}
          title="While on, unfolding or folding a row does the same in every document"
          onClick={() => setSync(!sync)}
          className={`rounded border px-1.5 py-0.5 ${sync ? 'border-emerald-600 bg-emerald-950 text-emerald-200' : 'border-zinc-700 hover:text-zinc-100'}`}
        >
          {sync ? '☑' : '☐'} ⇉ Sync unfold
        </button>
        <button
          type="button"
          disabled={!cursorRow}
          title="Unfold every document like the current one (=)"
          onClick={() => cursorRow && applyToAll(cursorRow.root)}
          className="rounded border border-zinc-700 px-1.5 py-0.5 enabled:hover:border-emerald-600 enabled:hover:text-emerald-200 disabled:opacity-40"
        >
          ⇶ Apply unfolds of ({(cursorRow?.root ?? 0) + 1}) to all
        </button>
        <span className="flex items-center gap-1">
          list items:
          <ItemMatchPicker value={match} onChange={setMatch} />
        </span>
        {notice && (
          <span role="status" className="text-emerald-400">
            {notice}
          </span>
        )}
        <span className="ml-auto hidden text-zinc-500 2xl:inline">→ unfold · ← fold · * links below · = apply to all</span>
        <button type="button" className={toolBtn} onClick={unfoldAllLinks}>
          {hasLinks ? '⊞ Unfold documents & links' : '⊞ Unfold documents'}
        </button>
        <button type="button" className={toolBtn} onClick={() => setExpanded(new Set())}>
          ⊟ Fold all
        </button>
      </div>
      <div
        ref={containerRef}
        data-grid
        tabIndex={0}
        role="tree"
        aria-label={`${collection} documents`}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto font-mono text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-emerald-600/70 focus-visible:ring-inset"
      >
        <div className="min-w-max">
          <div className="sticky top-0 z-10 grid border-b border-zinc-800 bg-zinc-900 text-left font-sans text-xs font-semibold text-zinc-300" style={grid}>
            <div className="relative px-2 py-1.5">
              Key
              <div
                role="separator"
                aria-orientation="vertical"
                title="Drag to resize"
                onPointerDown={startResize}
                className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-700"
              />
            </div>
            <div className="border-l border-zinc-800 px-2 py-1.5">Value</div>
            <div className="border-l border-zinc-800 px-2 py-1.5">Type</div>
          </div>
          {rows.map((row) => {
            const isCursor = row.id === cursor;
            const style = LEVEL_STYLE[row.level] ?? LEVEL_STYLE[1];
            const isOpen = expanded.has(row.id);
            const selected = row.rootIndex !== undefined && selection.has(row.rootIndex);
            return (
              <div
                key={row.id}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.expandable ? isOpen : undefined}
                aria-selected={isCursor}
                data-tree-row={row.id}
                onClick={() => {
                  setCursor(row.id);
                  if (row.expandable) toggle(row);
                }}
                className={`group/row grid cursor-pointer border-b border-zinc-900 leading-6 ${style?.rule ?? ''} ${
                  isCursor
                    ? 'bg-zinc-800'
                    : selected
                      ? 'bg-emerald-950/40'
                      : row.kind === 'relation'
                        ? 'bg-zinc-900/60 hover:bg-zinc-900'
                        : row.level > 1 && row.kind === 'doc'
                          ? 'bg-zinc-950 hover:bg-zinc-900'
                          : 'hover:bg-zinc-900'
                }`}
                style={grid}
              >
                <div className="flex min-w-0 items-center gap-1 truncate pr-2" style={{ paddingLeft: 8 + row.depth * 18 }}>
                  <span className="w-3 shrink-0 text-center text-zinc-500">{row.expandable ? (isOpen ? '▾' : '▸') : ''}</span>
                  {row.rootIndex !== undefined && (
                    <input
                      type="checkbox"
                      aria-label="Select document"
                      checked={selected}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleSelect(row.rootIndex as number)}
                    />
                  )}
                  <span className={`truncate ${row.kind === 'field' ? 'text-zinc-300' : (style?.key ?? '')}`}>{row.key}</span>
                  {row.rootIndex !== undefined && isOpen && (
                    <button
                      type="button"
                      title="Unfold every document like this one (=)"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCursor(row.id);
                        applyToAll(row.root);
                      }}
                      className="ml-1 shrink-0 rounded border border-zinc-700 px-1 font-sans text-[11px] text-zinc-400 opacity-0 group-hover/row:opacity-100 hover:border-emerald-600 hover:text-emerald-200 focus:opacity-100"
                    >
                      ⇶ apply to all
                    </button>
                  )}
                </div>
                <div className="min-w-0 truncate border-l border-zinc-900 px-2">{row.value}</div>
                <div className="truncate border-l border-zinc-900 px-2 font-sans text-xs leading-6 text-zinc-500">{row.type}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** "list items" dropdown: same values (code and / or custom key fields), same position, or all items. */
function ItemMatchPicker({ value, onChange }: { value: ItemMatch; onChange: (m: ItemMatch) => void }) {
  const set = (patch: Partial<ItemMatch>) => onChange({ ...value, ...patch });
  const values = value.mode === 'values';
  const radio = (mode: ItemMatch['mode'], label: string, hint: string) => (
    <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-zinc-800">
      <input type="radio" name="item-match" className="mt-0.5" checked={value.mode === mode} onChange={() => set({ mode })} />
      <span>
        <span className="text-zinc-100">{label}</span>
        <span className="block text-[11px] text-zinc-500">{hint}</span>
      </span>
    </label>
  );
  return (
    <Dropdown
      label={<span className="text-zinc-200">{matchLabel(value)}</span>}
      title="How list items (e.g. covers, contractors) are matched in the other documents"
      width={300}
    >
      <div className="flex flex-col gap-0.5" aria-label="Match list items by">
        {radio('values', 'Same values', 'The item whose key fields have the same values')}
        <div className={`ml-6 flex flex-col gap-1 border-l border-zinc-700 py-1 pl-3 ${values ? '' : 'opacity-50'}`}>
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={!values} checked={value.code} onChange={(e) => set({ code: e.target.checked })} />
            <span>
              <span className="font-mono text-zinc-100">code</span>
              <span className="text-zinc-500"> (badge field of the list)</span>
            </span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              disabled={!values}
              checked={value.custom}
              onChange={(e) => set({ custom: e.target.checked })}
            />
            custom
          </label>
          <input
            aria-label="Custom key fields"
            disabled={!values}
            value={value.customFields}
            placeholder="e.g. role, type.code"
            spellCheck={false}
            onChange={(e) => set({ customFields: e.target.value, custom: e.target.value.trim() !== '' || value.custom })}
            className="ml-6 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-xs text-zinc-100 outline-none focus:border-emerald-600 disabled:opacity-50"
          />
          <span className="ml-6 text-[11px] text-zinc-500">Only the fields an item has are compared; none of them → same position.</span>
        </div>
        {radio('index', 'Same position', 'The item at the same index ([0], [1], …)')}
        {radio('all', 'All items', 'Every item of the list')}
      </div>
    </Dropdown>
  );
}
