import { useMemo, useState } from 'react';
import type { ViewMode } from '../store/useTabStore';
import type { CollectionSchema, EjsonDoc, MasterDetailNode, RelationLevel } from '../types';
import type { DistinctScan } from './DistinctPopover';
import { Grid, rootSource, type GridRow } from './Grid';
import { MasterDetailView } from './MasterDetailView';
import { NestedTableView } from './NestedTableView';
import { RoboTree } from './RoboTree';

export interface DataViewerProps {
  collection: string;
  docs: EjsonDoc[];
  nodes: MasterDetailNode[] | null;
  viewMode: ViewMode;
  /** All documented schemas (linked collections look up their own). */
  schemas: Record<string, CollectionSchema>;
  /** Links used for this result, if any. */
  levels: RelationLevel[];
  selection: Set<number>;
  onSelectionChange: (selection: Set<number>) => void;
  /** Server-side distinct scan over the queried collection (Distinct Inspector). */
  scanDistinct?: DistinctScan | undefined;
  /** Detail sections switched off (linked collections / embedded arrays). */
  hiddenSections: string[];
  onHiddenSectionsChange: (hidden: string[]) => void;
  /** Embedded sub-document sections switched on (nested table; off by default). */
  shownSections?: string[];
  onShownSectionsChange?: (shown: string[]) => void;
}

/** Switcher: Flat Table vs Master-Detail panes vs Nested table vs Tree, all over the same result set. */
export function DataViewer(props: DataViewerProps) {
  if (props.docs.length === 0) {
    return <div className="p-4 text-sm text-zinc-500">No documents matched.</div>;
  }
  switch (props.viewMode) {
    case 'tree':
      return <RoboTree {...props} />;
    case 'nested':
      return <MasterDetailView {...props} />;
    case 'stack':
      return <NestedTableView {...props} />;
    default:
      return <FlatTable {...props} />;
  }
}

/** One grid over the top-level fields; Enter / click unfolds a row into its document tree. */
function FlatTable({ docs, nodes, collection, schemas, levels, selection, onSelectionChange, scanDistinct }: DataViewerProps) {
  const rows = useMemo<GridRow[]>(() => docs.map((doc, index) => ({ index, doc, node: nodes?.[index] })), [docs, nodes]);
  const [active, setActive] = useState<number | null>(null);
  const source = useMemo(() => rootSource(collection, schemas, docs[0]), [collection, schemas, docs]);
  return (
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
      showBadge={false}
      inlineTree
      maxColumns={60}
    />
  );
}
