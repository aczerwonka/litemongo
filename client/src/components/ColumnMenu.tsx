import { useState, type DragEvent } from 'react';
import { moveColumn } from '../store/useColumnPrefs';
import type { ColumnPref } from '../types';
import { Dropdown } from './ui';

/**
 * Column chooser of one grid: tick to show / hide, drag (or ↑ ↓) to reorder.
 * Header cells can be dragged too. Changes apply live and are kept per tab.
 */
export function ColumnMenu({
  columns,
  hidden,
  onChange,
}: {
  /** Every column id in the current order. */
  columns: string[];
  hidden: Set<string>;
  onChange: (pref: ColumnPref | null) => void;
}) {
  const shown = columns.length - columns.filter((c) => hidden.has(c)).length;
  return (
    // Clicks inside must not sort the column whose header hosts the menu.
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onDragStart={(e) => e.stopPropagation()} className="font-sans font-normal">
      <Dropdown
        label={<span title="Columns: show, hide, reorder">⚙</span>}
        title={`Columns: ${shown} of ${columns.length} shown — show, hide, reorder`}
        className="border-transparent px-0.5 py-0 text-[11px] text-zinc-500"
        width={300}
      >
        <ColumnList columns={columns} hidden={hidden} onChange={onChange} />
      </Dropdown>
    </span>
  );
}

const label = (id: string) => (id.startsWith('__child_') ? `⛓ ${id.slice('__child_'.length)}` : id);

function ColumnList({ columns, hidden, onChange }: { columns: string[]; hidden: Set<string>; onChange: (pref: ColumnPref | null) => void }) {
  const [filter, setFilter] = useState('');
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const commit = (order: string[], nextHidden: Set<string>) =>
    onChange({ order, ...(nextHidden.size > 0 ? { hidden: [...nextHidden] } : {}) });
  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    commit(columns, next);
  };
  const step = (id: string, by: -1 | 1) => {
    const i = columns.indexOf(id);
    const j = i + by;
    if (j < 0 || j >= columns.length) return;
    const next = [...columns];
    [next[i], next[j]] = [next[j] as string, next[i] as string];
    commit(next, hidden);
  };
  const setAll = (on: boolean) => commit(columns, on ? new Set() : new Set(columns));
  const needle = filter.toLowerCase();
  const list = columns.filter((c) => !needle || label(c).toLowerCase().includes(needle));
  const dropProps = (id: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!drag || drag === id) return;
      e.preventDefault();
      setOver(id);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      if (drag && drag !== id) commit(moveColumn(columns, drag, id), hidden);
      setDrag(null);
      setOver(null);
    },
  });

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={filter}
          placeholder="Filter columns…"
          aria-label="Filter columns"
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-xs text-zinc-100 outline-none focus:border-emerald-600"
        />
        <button type="button" className="rounded px-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" onClick={() => setAll(true)} title="Show every column">
          all
        </button>
        <button type="button" className="rounded px-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" onClick={() => setAll(false)} title="Hide every column">
          none
        </button>
        <button type="button" className="rounded px-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" onClick={() => onChange(null)} title="Natural order, everything shown">
          reset
        </button>
      </div>
      <ul className="flex flex-col">
        {list.map((id) => (
          <li
            key={id}
            draggable={!needle}
            onDragStart={() => setDrag(id)}
            onDragEnd={() => {
              setDrag(null);
              setOver(null);
            }}
            {...dropProps(id)}
            className={`group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-zinc-800 ${over === id ? 'shadow-[inset_0_2px_0_var(--color-emerald-500)]' : ''} ${drag === id ? 'opacity-50' : ''}`}
          >
            <span className={`cursor-grab text-zinc-600 ${needle ? 'invisible' : ''}`} aria-hidden>
              ⋮⋮
            </span>
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={!hidden.has(id)} onChange={() => toggle(id)} />
              <span className={`truncate font-mono ${hidden.has(id) ? 'text-zinc-500' : 'text-zinc-100'} ${id.startsWith('__child_') ? 'text-emerald-300' : ''}`}>{label(id)}</span>
            </label>
            <span className="flex opacity-0 group-hover:opacity-100">
              <button type="button" className="px-0.5 text-zinc-500 hover:text-zinc-100" onClick={() => step(id, -1)} aria-label={`Move ${label(id)} up`}>
                ↑
              </button>
              <button type="button" className="px-0.5 text-zinc-500 hover:text-zinc-100" onClick={() => step(id, 1)} aria-label={`Move ${label(id)} down`}>
                ↓
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
