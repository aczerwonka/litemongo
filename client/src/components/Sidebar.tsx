import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, defaultDbFromUri } from '../lib/api';
import {
  contextFor,
  ENV_STYLES,
  useConnectionStore,
  useProfile,
  type ConnectionProfile,
} from '../store/useConnectionStore';
import { useActiveTab, useTabStore } from '../store/useTabStore';
import { ConnectionDialog } from './ConnectionDialog';
import { Button, ErrorBox, inputClass, useServerInfo } from './ui';

export function Sidebar() {
  const profiles = useConnectionStore((s) => s.profiles);
  const remove = useConnectionStore((s) => s.remove);
  const forgetConnection = useTabStore((s) => s.forgetConnection);
  const updateTab = useTabStore((s) => s.updateTab);
  const addTab = useTabStore((s) => s.addTab);
  const tab = useActiveTab();
  const profile = useProfile(tab.connectionId);
  const [editing, setEditing] = useState<ConnectionProfile | 'new' | null>(null);

  const selectProfile = (p: ConnectionProfile) => {
    if (p.id === tab.connectionId) return;
    if (tab.collection) {
      addTab({ connectionId: p.id, db: defaultDbFromUri(p.uri) });
    } else {
      updateTab(tab.id, { connectionId: p.id, db: defaultDbFromUri(p.uri), collection: null, lastRun: null });
    }
  };

  const deleteProfile = (p: ConnectionProfile) => {
    if (!window.confirm(`Delete connection "${p.name}" from this browser?`)) return;
    remove(p.id);
    forgetConnection(p.id);
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Connections</span>
        <Button variant="ghost" className="px-1.5 py-0" onClick={() => setEditing('new')} aria-label="Add connection">
          +
        </Button>
      </div>
      <ul className="px-1.5">
        {profiles.length === 0 && (
          <li className="px-2 py-2 text-sm text-zinc-500">
            No connections yet.{' '}
            <button type="button" className="text-emerald-400 hover:underline" onClick={() => setEditing('new')}>
              Add one
            </button>
          </li>
        )}
        {profiles.map((p) => (
          <li key={p.id} className="group flex items-center">
            <button
              type="button"
              onClick={() => selectProfile(p)}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${p.id === tab.connectionId ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-300 hover:bg-zinc-800/60'}`}
            >
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${ENV_STYLES[p.env].dot}`} />
              <span className="truncate">{p.name}</span>
              <span className={`ml-auto text-[10px] font-semibold ${ENV_STYLES[p.env].text}`}>{ENV_STYLES[p.env].label}</span>
              {(p.readOnly || ENV_STYLES[p.env].locked) && <span title="Read-only" className="text-xs">🔒</span>}
            </button>
            <button
              type="button"
              className="hidden px-1 text-xs text-zinc-500 group-hover:block hover:text-zinc-200"
              onClick={() => setEditing(p)}
              aria-label={`Edit ${p.name}`}
            >
              ✎
            </button>
            <button
              type="button"
              className="hidden px-1 text-xs text-zinc-500 group-hover:block hover:text-red-400"
              onClick={() => deleteProfile(p)}
              aria-label={`Delete ${p.name}`}
            >
              🗑
            </button>
          </li>
        ))}
      </ul>

      {profile && <Browser profile={profile} />}

      {editing && (
        <ConnectionDialog
          profile={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            if (editing === 'new' && !tab.connectionId) {
              updateTab(tab.id, { connectionId: p.id, db: defaultDbFromUri(p.uri) });
            }
          }}
        />
      )}
    </aside>
  );
}

/** Database picker + collection list for the active tab's connection. */
function Browser({ profile }: { profile: ConnectionProfile }) {
  const tab = useActiveTab();
  const updateTab = useTabStore((s) => s.updateTab);
  const addTab = useTabStore((s) => s.addTab);
  const forceReadOnly = useServerInfo().data?.forceReadOnly ?? false;
  const conn = contextFor(profile, forceReadOnly);
  const uriDb = defaultDbFromUri(profile.uri);

  const dbs = useQuery({
    queryKey: ['databases', profile.id, profile.uri],
    queryFn: () => api.databases(conn),
    staleTime: 60_000,
  });
  // Restricted (read-role) users may not list databases: fall back to the URI's db.
  const dbNames = dbs.data?.databases ?? (uriDb ? [uriDb] : []);
  const db = tab.db ?? uriDb ?? dbNames.find((n) => !['admin', 'config', 'local'].includes(n)) ?? null;

  const cols = useQuery({
    queryKey: ['collections', profile.id, profile.uri, db],
    queryFn: () => api.collections(conn, db as string),
    enabled: !!db,
    staleTime: 60_000,
  });

  const openCollection = (name: string) => {
    if (tab.mode === 'script') addTab({ connectionId: profile.id, db, collection: name });
    else if (!tab.collection) updateTab(tab.id, { db, collection: name, lastRun: null });
    else if (tab.collection !== name || tab.db !== db) addTab({ connectionId: profile.id, db, collection: name });
  };

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-zinc-800">
      <div className="px-3 pt-3 pb-2">
        <select
          className={`${inputClass} w-full`}
          value={db ?? ''}
          onChange={(e) => updateTab(tab.id, { db: e.target.value || null, collection: null, lastRun: null })}
          aria-label="Database"
        >
          {!db && <option value="">Select database…</option>}
          {dbNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          {db && !dbNames.includes(db) && <option value={db}>{db}</option>}
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-3">
        {dbs.isError && !uriDb && <div className="px-2"><ErrorBox error={dbs.error} /></div>}
        {cols.isLoading && <div className="px-2 text-sm text-zinc-500">Loading…</div>}
        {cols.isError && <div className="px-2"><ErrorBox error={cols.error} /></div>}
        <ul>
          {cols.data?.collections.map((name) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => openCollection(name)}
                className={`w-full truncate rounded px-2 py-1 text-left font-mono text-sm ${tab.collection === name && tab.db === db ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'}`}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
