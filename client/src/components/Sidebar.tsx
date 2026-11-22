import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, defaultDbFromUri } from '../lib/api';
import { connect, disconnect, reconnectIfChanged } from '../lib/connections';
import { contextFor, ENV_STYLES, useConnectionStore, type ConnectionProfile } from '../store/useConnectionStore';
import { useLive, useSessionStore } from '../store/useSessionStore';
import { useActiveTab, useTabStore } from '../store/useTabStore';
import { ConnectionDialog } from './ConnectionDialog';
import { Button, ErrorBox, inputClass, useServerInfo } from './ui';

/**
 * Connection tree: every profile can be connected / disconnected on its own;
 * each connected profile has its own database picker and collection list.
 */
export function Sidebar() {
  const profiles = useConnectionStore((s) => s.profiles);
  const remove = useConnectionStore((s) => s.remove);
  const closeConnectionTabs = useTabStore((s) => s.closeConnectionTabs);
  const [editing, setEditing] = useState<ConnectionProfile | 'new' | null>(null);

  const deleteProfile = (p: ConnectionProfile) => {
    if (!window.confirm(`Delete connection "${p.name}" from this browser?\n\nIts tabs are closed.`)) return;
    void disconnect(p);
    closeConnectionTabs(p.id);
    remove(p.id);
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Connections</span>
        <Button variant="ghost" className="px-1.5 py-0" onClick={() => setEditing('new')} aria-label="Add connection" title="Add connection">
          +
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-3">
        {profiles.length === 0 && (
          <div className="px-2 py-2 text-sm text-zinc-500">
            No connections yet.{' '}
            <button type="button" className="text-emerald-400 hover:underline" onClick={() => setEditing('new')}>
              Add one
            </button>
          </div>
        )}
        {profiles.map((p) => (
          <ConnectionNode key={p.id} profile={p} onEdit={() => setEditing(p)} onDelete={() => deleteProfile(p)} />
        ))}
      </div>

      {editing && (
        <ConnectionDialog
          profile={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            if (editing === 'new') void connect(p);
            else void reconnectIfChanged(editing, p);
          }}
        />
      )}
    </aside>
  );
}

function ConnectionNode({ profile: p, onEdit, onDelete }: { profile: ConnectionProfile; onEdit: () => void; onDelete: () => void }) {
  const live = useLive(p.id);
  const collapsed = useSessionStore((s) => !!s.collapsed[p.id]);
  const toggleCollapsed = useSessionStore((s) => s.toggleCollapsed);
  const showConnection = useTabStore((s) => s.showConnection);
  const tabCount = useTabStore((s) => s.tabs.filter((t) => t.connectionId === p.id).length);
  const tab = useActiveTab();
  const style = ENV_STYLES[p.env];
  const connected = live?.status === 'connected';
  const connecting = live?.status === 'connecting';
  const isCurrent = tab.connectionId === p.id;

  const onClick = () => {
    // Connecting is explicit: only the ▶ button connects.
    if (!connected) return;
    if (isCurrent) toggleCollapsed(p.id);
    else {
      toggleCollapsed(p.id, false);
      showConnection(p.id, useSessionStore.getState().browseDb[p.id] ?? defaultDbFromUri(p.uri));
    }
  };

  const onDisconnect = () => {
    const closeTabs =
      tabCount > 0 && window.confirm(`Disconnect "${p.name}".\n\nAlso close its ${tabCount} tab(s)?\nOK = close tabs, Cancel = keep them for later.`);
    void disconnect(p, { closeTabs });
  };

  return (
    <div className="mb-0.5">
      <div className="group flex items-center">
        <button
          type="button"
          onClick={onClick}
          title={
            connected
              ? `Connected${live?.serverVersion ? ` · MongoDB ${live.serverVersion}` : ''}${live?.pingMs !== undefined ? ` · ${live.pingMs} ms` : ''}`
              : live?.status === 'error'
                ? `Connection failed: ${live.error}\nPress ▶ to retry`
                : 'Disconnected — press ▶ to connect'
          }
          className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${isCurrent && connected ? 'bg-zinc-800 text-zinc-50' : connected ? 'text-zinc-200 hover:bg-zinc-800/60' : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300'}`}
        >
          <span className="w-3 shrink-0 text-[10px] text-zinc-500">{connected ? (collapsed ? '▸' : '▾') : ''}</span>
          <StatusDot status={live?.status} dot={style.dot} border={style.border} />
          <span className="truncate">{p.name}</span>
          <span className={`ml-auto text-[10px] font-semibold ${connected ? style.text : 'text-zinc-600'}`}>{style.label}</span>
          {(p.readOnly || style.locked) && <span title="Read-only" className="text-xs">🔒</span>}
        </button>
        {connected ? (
          <button
            type="button"
            className="px-1 text-xs text-zinc-500 hover:text-amber-300"
            onClick={onDisconnect}
            aria-label={`Disconnect ${p.name}`}
            title="Disconnect"
          >
            ⏏
          </button>
        ) : (
          <button
            type="button"
            className="px-1 text-xs text-zinc-500 hover:text-emerald-400 disabled:opacity-40"
            onClick={() => void connect(p)}
            disabled={connecting}
            aria-label={`Connect ${p.name}`}
            title="Connect"
          >
            ▶
          </button>
        )}
        <button
          type="button"
          className="hidden px-1 text-xs text-zinc-500 group-hover:block hover:text-zinc-200"
          onClick={onEdit}
          aria-label={`Edit ${p.name}`}
          title="Edit"
        >
          ✎
        </button>
        <button
          type="button"
          className="hidden px-1 text-xs text-zinc-500 group-hover:block hover:text-red-400"
          onClick={onDelete}
          aria-label={`Delete ${p.name}`}
          title="Delete"
        >
          🗑
        </button>
      </div>
      {live?.status === 'error' && <div className="truncate px-7 text-xs text-red-400" title={live.error}>{live.error}</div>}
      {connected && !collapsed && <Browser profile={p} />}
    </div>
  );
}

function StatusDot({ status, dot, border }: { status: string | undefined; dot: string; border: string }) {
  if (status === 'connected') return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />;
  if (status === 'connecting') return <span className={`h-2.5 w-2.5 shrink-0 animate-pulse rounded-full border-2 ${border}`} />;
  if (status === 'error') return <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-red-500" />;
  return <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-zinc-600" />;
}

/** Database picker + collection list of one connected profile. */
function Browser({ profile }: { profile: ConnectionProfile }) {
  const tab = useActiveTab();
  const tabs = useTabStore((s) => s.tabs);
  const updateTab = useTabStore((s) => s.updateTab);
  const addTab = useTabStore((s) => s.addTab);
  const setActive = useTabStore((s) => s.setActive);
  const chosenDb = useSessionStore((s) => s.browseDb[profile.id]);
  const setBrowseDb = useSessionStore((s) => s.setBrowseDb);
  const forceReadOnly = useServerInfo().data?.forceReadOnly ?? false;
  const conn = contextFor(profile, forceReadOnly);
  const uriDb = defaultDbFromUri(profile.uri);
  const isCurrent = tab.connectionId === profile.id;

  const dbs = useQuery({
    queryKey: ['databases', profile.id, profile.uri],
    queryFn: () => api.databases(conn),
    staleTime: 60_000,
  });
  // Restricted (read-role) users may not list databases: fall back to the URI's db.
  const dbNames = dbs.data?.databases ?? (uriDb ? [uriDb] : []);
  const db = chosenDb ?? uriDb ?? dbNames.find((n) => !['admin', 'config', 'local'].includes(n)) ?? null;

  const cols = useQuery({
    queryKey: ['collections', profile.id, profile.uri, db],
    queryFn: () => api.collections(conn, db as string),
    enabled: !!db,
    staleTime: 60_000,
  });

  const pickDb = (next: string | null) => {
    setBrowseDb(profile.id, next);
    if (isCurrent && !tab.collection && tab.mode === 'query') updateTab(tab.id, { db: next, lastRun: null });
  };

  const openCollection = (name: string) => {
    const open = tabs.find((t) => t.connectionId === profile.id && t.mode === 'query' && t.db === db && t.collection === name);
    if (open) setActive(open.id);
    else if (isCurrent && tab.mode === 'query' && !tab.collection) updateTab(tab.id, { db, collection: name, lastRun: null });
    else addTab({ connectionId: profile.id, db, collection: name });
  };

  return (
    <div className="mb-2 ml-3 border-l border-zinc-800 pl-2">
      <select
        className={`${inputClass} my-1 w-full py-0.5 text-xs`}
        value={db ?? ''}
        onChange={(e) => pickDb(e.target.value || null)}
        aria-label={`Database on ${profile.name}`}
      >
        {!db && <option value="">Select database…</option>}
        {dbNames.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
        {db && !dbNames.includes(db) && <option value={db}>{db}</option>}
      </select>
      {dbs.isError && !uriDb && <ErrorBox error={dbs.error} />}
      {cols.isLoading && <div className="px-2 text-xs text-zinc-500">Loading…</div>}
      {cols.isError && <ErrorBox error={cols.error} />}
      {cols.data && cols.data.collections.length === 0 && <div className="px-2 text-xs text-zinc-600">No collections</div>}
      <ul>
        {cols.data?.collections.map((name) => (
          <li key={name}>
            <button
              type="button"
              onClick={() => openCollection(name)}
              className={`w-full truncate rounded px-2 py-0.5 text-left font-mono text-sm ${isCurrent && tab.collection === name && tab.db === db ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'}`}
            >
              {name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
