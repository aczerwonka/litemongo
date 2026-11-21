import { createContext, useContext } from 'react';
import type { ColumnPref, ColumnPrefs } from '../types';

/**
 * Column order and hidden columns of every grid in a tab (master grid and each
 * nested detail table), keyed by the grid's source: the collection, plus the
 * embedded array path for array tables (`policies2`, `policies2:covers[]`).
 * Provided by DataViewer from the tab; saved with a view.
 */

export interface ColumnsControl {
  prefs: ColumnPrefs;
  set: (key: string, pref: ColumnPref | null) => void;
}

export const ColumnsContext = createContext<ColumnsControl | null>(null);
export const useColumnsControl = () => useContext(ColumnsContext);

export function columnsKey(collection: string, display: string): string {
  return display ? `${collection}:${display}` : collection;
}

/** Apply a pref to the natural column order: saved order first (ids still present), then the rest. */
export function arrangeColumns(natural: string[], pref: ColumnPref | undefined): { ordered: string[]; visible: string[] } {
  if (!pref) return { ordered: natural, visible: natural };
  const present = new Set(natural);
  const head = (pref.order ?? []).filter((id) => present.has(id));
  const headSet = new Set(head);
  const ordered = [...head, ...natural.filter((id) => !headSet.has(id))];
  const hidden = new Set(pref.hidden ?? []);
  return { ordered, visible: ordered.filter((id) => !hidden.has(id)) };
}

/** Move `id` to sit before `before` (or to the end when null). */
export function moveColumn(ordered: string[], id: string, before: string | null): string[] {
  const rest = ordered.filter((x) => x !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  rest.splice(at < 0 ? rest.length : at, 0, id);
  return rest;
}
