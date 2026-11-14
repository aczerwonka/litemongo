import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DistinctResponse } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { classify } from '../lib/ejson';
import { distinctCounts, leafPaths, type DistinctCount } from '../lib/paths';
import { Scalar } from './values';
import { toast } from './ui';

/** Runs a server-side distinct scan over the whole (filtered) collection. */
export type DistinctScan = (path: string) => Promise<DistinctResponse>;

const MAX_ROWS = 200;

/**
 * Small header button that opens the Quick Distinct Inspector: distinct values
 * and frequency counts of a field across the active result set, with drill-down
 * into nested paths (covers -> covers.loadings.code) and an optional bounded
 * server-side scan of the collection.
 */
export function DistinctButton({ path, docs, scan }: { path: string; docs: unknown[]; scan?: DistinctScan | undefined }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title={`Distinct values of ${path}`}
        aria-label={`Distinct values of ${path}`}
        aria-expanded={open}
        className={`ml-1 rounded px-0.5 text-[11px] font-normal ${open ? 'text-emerald-300' : 'text-zinc-600 hover:text-zinc-200'}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⊞
      </button>
      {open && buttonRef.current && (
        <DistinctPopover anchor={buttonRef.current} initialPath={path} docs={docs} scan={scan} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

type Source = 'results' | 'collection';

function DistinctPopover({
  anchor,
  initialPath,
  docs,
  scan,
  onClose,
}: {
  anchor: HTMLElement;
  initialPath: string;
  docs: unknown[];
  scan?: DistinctScan | undefined;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [path, setPath] = useState(initialPath);
  const [source, setSource] = useState<Source>('results');
  const [scanState, setScanState] = useState<{ path: string; data?: DistinctResponse; error?: string; loading: boolean } | null>(
    null,
  );
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const width = 360;
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panelRef.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  const local = useMemo(() => distinctCounts(docs, path), [docs, path]);
  const drill = useMemo(() => leafPaths(docs, initialPath), [docs, initialPath]);

  const runScan = (p: string) => {
    if (!scan) return;
    setScanState({ path: p, loading: true });
    scan(p).then(
      (data) => setScanState({ path: p, data, loading: false }),
      (err: unknown) => setScanState({ path: p, error: (err as Error).message, loading: false }),
    );
  };

  useEffect(() => {
    if (source === 'collection' && scanState?.path !== path) runScan(path);
  }, [source, path]); // runScan/scanState read fresh each time; re-run only on source/path change

  let values: DistinctCount[];
  let footer: string;
  if (source === 'collection') {
    const d = scanState?.path === path ? scanState.data : undefined;
    values = d?.values ?? [];
    footer = d
      ? `${d.values.length}${d.hasMore ? '+' : ''} distinct · matching docs (scan cap ${d.sampleLimit.toLocaleString()}) · ${d.ms} ms`
      : '';
  } else {
    values = local.values;
    footer = `${local.values.length} distinct across ${docs.length} doc${docs.length === 1 ? '' : 's'}${local.missing ? ` · ${local.missing} missing` : ''}`;
  }
  const max = values.reduce((m, v) => Math.max(m, v.count), 0) || 1;
  const allScalar = values.every((v) => !['object', 'array'].includes(classify(v.value).kind));

  const copyIn = async () => {
    const text = JSON.stringify({ [path]: { $in: values.map((v) => v.value) } });
    toast((await copyText(text)) ? `Copied $in filter for ${path}` : 'Clipboard unavailable', 'info');
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Distinct values of ${path}`}
      style={{ top: pos.top, left: pos.left }}
      className="fixed z-50 flex max-h-[60vh] w-[360px] flex-col rounded-md border border-zinc-700 bg-zinc-900 font-sans text-sm font-normal text-zinc-200 shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className="truncate font-mono text-xs text-zinc-100" title={path}>
          {path}
        </span>
        <div className="ml-auto flex overflow-hidden rounded border border-zinc-700 text-xs">
          <button
            type="button"
            className={`px-1.5 py-0.5 ${source === 'results' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800'}`}
            onClick={() => setSource('results')}
          >
            Results
          </button>
          <button
            type="button"
            disabled={!scan}
            title={scan ? 'Aggregate over the collection (current filter, bounded scan)' : 'Not available for nested tables'}
            className={`px-1.5 py-0.5 disabled:opacity-40 ${source === 'collection' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800'}`}
            onClick={() => setSource('collection')}
          >
            Collection
          </button>
        </div>
      </div>

      {drill.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-zinc-800 px-3 py-1.5">
          {[initialPath, ...drill].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPath(p)}
              className={`rounded px-1 font-mono text-[11px] ${p === path ? 'bg-emerald-800 text-emerald-50' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-100'}`}
            >
              {p === initialPath ? p : p.slice(initialPath.length + 1)}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        {source === 'collection' && scanState?.loading && <div className="px-2 py-1 text-zinc-500">Scanning…</div>}
        {source === 'collection' && scanState?.error && <div className="px-2 py-1 text-red-300">{scanState.error}</div>}
        {values.length === 0 && !(source === 'collection' && (scanState?.loading || scanState?.error)) && (
          <div className="px-2 py-1 text-zinc-500">No values.</div>
        )}
        <table className="w-full font-mono text-xs">
          <tbody>
            {values.slice(0, MAX_ROWS).map((v, i) => (
              <tr key={i} className="hover:bg-zinc-800/60">
                <td className="max-w-[220px] truncate px-2 py-0.5">
                  <Scalar value={v.value} typed={false} />
                </td>
                <td className="w-24 px-2 py-0.5">
                  <div className="h-1.5 rounded bg-emerald-600/70" style={{ width: `${(v.count / max) * 100}%` }} />
                </td>
                <td className="w-10 px-2 py-0.5 text-right text-zinc-400">{v.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {values.length > MAX_ROWS && <div className="px-2 py-1 text-xs text-zinc-500">… {values.length - MAX_ROWS} more</div>}
      </div>

      <div className="flex items-center gap-2 border-t border-zinc-800 px-3 py-1.5 text-xs text-zinc-500">
        <span className="truncate">{footer}</span>
        {values.length > 0 && allScalar && (
          <button type="button" className="ml-auto shrink-0 text-zinc-300 hover:text-zinc-50" onClick={copyIn}>
            Copy as $in
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
