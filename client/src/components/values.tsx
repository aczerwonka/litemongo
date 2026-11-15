import { Fragment } from 'react';
import { classify, shellText, sortKey, type ValueKind } from '../lib/ejson';
import { useBadges } from '../store/useViewPrefsStore';
import { badgeFieldFor } from '../store/useWorkspaceStore';
import type { CollectionSchema } from '../types';

/** Shared, read-only renderers for canonical-EJSON values (tree, tables, popovers). */

export const KIND_CLASS: Record<ValueKind, string> = {
  objectId: 'text-amber-300',
  date: 'text-sky-300',
  decimal: 'text-emerald-300',
  int: 'text-emerald-300',
  long: 'text-emerald-300',
  double: 'text-emerald-300',
  string: 'text-orange-200',
  bool: 'text-violet-300',
  null: 'text-zinc-500 italic',
  uuid: 'text-amber-300',
  binary: 'text-zinc-400',
  regex: 'text-pink-300',
  timestamp: 'text-sky-300',
  other: 'text-zinc-300',
  object: 'text-zinc-500',
  array: 'text-zinc-500',
};

export function Scalar({ value, typed = true }: { value: unknown; typed?: boolean }) {
  const c = classify(value);
  const text = typed ? shellText(value) : c.text;
  return (
    <span className={KIND_CLASS[c.kind]} title={c.type}>
      {text}
    </span>
  );
}

/** A domain `code` badge, e.g. [COVER_COLLISION]. */
export function CodeBadge({ value, title }: { value: unknown; title?: string }) {
  if (!useBadges()) return null;
  const text = value === undefined ? '∅' : classify(value).text;
  return (
    <span
      className="rounded border border-indigo-700 bg-indigo-950 px-1 font-mono text-[11px] whitespace-nowrap text-indigo-200"
      title={title}
    >
      [{text}]
    </span>
  );
}

export function Badges({ items, field, max = 6 }: { items: unknown[]; field: string; max?: number }) {
  if (!useBadges()) return null;
  const shown = items.slice(0, max);
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {shown.map((item, i) => (
        <CodeBadge key={i} value={(item as Record<string, unknown> | null)?.[field]} title={field} />
      ))}
      {items.length > shown.length && <span className="text-xs text-zinc-500">+{items.length - shown.length}</span>}
    </span>
  );
}

/** Compact one-line rendering for table cells and collapsed tree nodes. */
export function Compact({ value, schema, path }: { value: unknown; schema: CollectionSchema | undefined; path: string[] }) {
  const badges = useBadges();
  const c = classify(value);
  if (c.kind === 'array') {
    const items = value as unknown[];
    const badge = badges ? badgeFieldFor(schema, path, items[0]) : undefined;
    if (badge && items.length > 0) return <Badges items={items} field={badge} />;
    if (items.length > 0 && items.every((v) => !['object', 'array'].includes(classify(v).kind))) {
      return (
        <span className="text-zinc-400">
          [{items.slice(0, 4).map((v, i) => (
            <Fragment key={i}>
              {i > 0 && ', '}
              <Scalar value={v} typed={false} />
            </Fragment>
          ))}
          {items.length > 4 && `, … ${items.length - 4} more`}]
        </span>
      );
    }
    return <span className="text-zinc-500">[{items.length} items]</span>;
  }
  if (c.kind === 'object') {
    const obj = value as Record<string, unknown>;
    const badge = badges ? badgeFieldFor(schema, path, obj) : undefined;
    if (badge && obj[badge] !== undefined) return <Badges items={[obj]} field={badge} />;
    const keys = Object.keys(obj);
    return <span className="text-zinc-500">{`{ ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''} }`}</span>;
  }
  return <Scalar value={value} typed={false} />;
}

/** tanstack sortingFn over EJSON cell values (numbers numerically, the rest as text). */
export function compareEjson(x: unknown, y: unknown): number {
  const a = sortKey(x);
  const b = sortKey(y);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}
