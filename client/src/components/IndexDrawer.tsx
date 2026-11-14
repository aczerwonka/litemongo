import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, type ConnectionContext, type IndexInfo } from '../lib/api';
import { classify, shellText } from '../lib/ejson';
import { Button, ErrorBox } from './ui';

/** Lightweight right-hand drawer listing the indexes of the active collection. */
export function IndexDrawer({
  conn,
  connectionId,
  db,
  collection,
  onClose,
}: {
  conn: ConnectionContext;
  connectionId: string;
  db: string;
  collection: string;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ['indexes', connectionId, db, collection],
    queryFn: () => api.indexes(conn, db, collection),
    staleTime: 60_000,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      aria-label={`Indexes on ${collection}`}
      className="fixed top-0 right-0 bottom-0 z-40 flex w-[420px] max-w-full flex-col border-l border-zinc-700 bg-zinc-900 shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <h2 className="text-base font-semibold">Indexes</h2>
        <span className="truncate font-mono text-sm text-zinc-400">
          {db}.{collection}
        </span>
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" onClick={() => void query.refetch()} disabled={query.isFetching} title="Reload">
            ↻
          </Button>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {query.isLoading && <div className="text-sm text-zinc-500">Loading…</div>}
        {query.isError && <ErrorBox error={query.error} />}
        {query.data && (
          <ul className="flex flex-col gap-2">
            {query.data.indexes.map((index) => (
              <IndexCard key={index.name} index={index} />
            ))}
          </ul>
        )}
      </div>
      {query.data && (
        <div className="border-t border-zinc-800 px-4 py-2 text-xs text-zinc-500">
          {query.data.indexes.length} index{query.data.indexes.length === 1 ? '' : 'es'}
        </div>
      )}
    </aside>
  );
}

const KNOWN = new Set(['v', 'key', 'name', 'unique', 'sparse', 'expireAfterSeconds', 'partialFilterExpression', 'hidden', 'ns']);

function direction(value: unknown): string {
  const c = classify(value);
  if (c.kind === 'string') return c.text; // text, 2dsphere, hashed, …
  return Number(c.text) < 0 ? '↓ desc' : '↑ asc';
}

function IndexCard({ index }: { index: IndexInfo }) {
  const flags: string[] = [];
  if (index.unique) flags.push('unique');
  if (index.sparse) flags.push('sparse');
  if (index.hidden) flags.push('hidden');
  if (index.expireAfterSeconds !== undefined) flags.push(`TTL ${classify(index.expireAfterSeconds).text}s`);
  if (index.partialFilterExpression) flags.push('partial');
  const extra = Object.entries(index).filter(([k]) => !KNOWN.has(k));
  return (
    <li className="rounded border border-zinc-800 bg-zinc-950 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-sm text-zinc-100">{index.name}</span>
        {flags.map((f) => (
          <span key={f} className="rounded bg-zinc-800 px-1.5 text-[11px] text-amber-200">
            {f}
          </span>
        ))}
      </div>
      <table className="mt-1.5 font-mono text-xs">
        <tbody>
          {Object.entries(index.key).map(([field, dir]) => (
            <tr key={field}>
              <td className="pr-3 text-zinc-300">{field}</td>
              <td className="text-zinc-500">{direction(dir)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {index.partialFilterExpression && (
        <div className="mt-1 font-mono text-[11px] break-all text-zinc-500">
          partial: {JSON.stringify(index.partialFilterExpression)}
        </div>
      )}
      {extra.length > 0 && (
        <div className="mt-1 font-mono text-[11px] break-all text-zinc-500">
          {extra.map(([k, v]) => `${k}: ${classify(v).kind === 'object' ? JSON.stringify(v) : shellText(v)}`).join(' · ')}
        </div>
      )}
    </li>
  );
}
