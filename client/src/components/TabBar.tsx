import { maskUri } from '../lib/api';
import { ENV_STYLES, isLockedEnv, useConnectionStore, useProfile } from '../store/useConnectionStore';
import { tabTitle, useActiveTab, useTabStore } from '../store/useTabStore';
import { useServerInfo } from './ui';

export function TabBar() {
  const tabs = useTabStore((s) => s.tabs);
  const activeId = useTabStore((s) => s.activeId);
  const setActive = useTabStore((s) => s.setActive);
  const closeTab = useTabStore((s) => s.closeTab);
  const addTab = useTabStore((s) => s.addTab);
  const profiles = useConnectionStore((s) => s.profiles);
  const active = useActiveTab();

  return (
    <div className="flex flex-col">
      <div className="flex items-end gap-0.5 overflow-x-auto border-b border-zinc-800 bg-zinc-950 px-2 pt-1.5">
        {tabs.map((t) => {
          const p = profiles.find((x) => x.id === t.connectionId);
          const isActive = t.id === activeId;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              onClick={() => setActive(t.id)}
              onKeyDown={(e) => e.key === 'Enter' && setActive(t.id)}
              onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
              className={`group flex max-w-56 cursor-pointer items-center gap-2 rounded-t border-x border-t px-3 py-1.5 text-sm ${isActive ? 'border-zinc-700 bg-zinc-900 text-zinc-50' : 'border-transparent text-zinc-400 hover:bg-zinc-900/60'}`}
            >
              {p && <span className={`h-2 w-2 shrink-0 rounded-full ${ENV_STYLES[p.env].dot}`} />}
              <span className="truncate font-mono">{tabTitle(t)}</span>
              <button
                type="button"
                aria-label="Close tab"
                className="text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-zinc-100"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
        <button
          type="button"
          aria-label="New tab"
          className="px-2 py-1.5 text-zinc-400 hover:text-zinc-100"
          onClick={() => addTab({ connectionId: active.connectionId, db: active.db })}
        >
          +
        </button>
      </div>
      <EnvBanner />
    </div>
  );
}

/** Color-coded environment safety banner with the one-click Read-Only lock. */
function EnvBanner() {
  const tab = useActiveTab();
  const profile = useProfile(tab.connectionId);
  const setReadOnly = useConnectionStore((s) => s.setReadOnly);
  const forceReadOnly = useServerInfo().data?.forceReadOnly ?? false;

  if (!profile) {
    return (
      <div className="bg-zinc-800 px-4 py-1.5 text-sm text-zinc-400">
        No connection selected. Pick or add one on the left.
      </div>
    );
  }
  const style = ENV_STYLES[profile.env];
  const envLocked = isLockedEnv(profile.env);
  const locked = forceReadOnly || envLocked || profile.readOnly;

  const toggle = () => {
    if (forceReadOnly || envLocked) return;
    if (profile.readOnly && profile.env === 'test') {
      const ok = window.confirm(`Unlock WRITES on "${profile.name}" (${style.label})?\n\nPaste and scripts will be able to modify this environment.`);
      if (!ok) return;
    }
    setReadOnly(profile.id, !profile.readOnly);
  };

  return (
    <div className={`flex items-center gap-3 px-4 py-1.5 text-sm text-white ${style.banner}`}>
      <span className="font-semibold">{profile.name}</span>
      <span className="rounded bg-black/25 px-1.5 py-0.5 text-xs tracking-wide uppercase">{style.label}</span>
      <span className="hidden truncate font-mono text-xs text-white/70 md:inline">{maskUri(profile.uri)}</span>
      {tab.db && (
        <span className="font-mono text-xs text-white/90">
          {tab.db}
          {tab.collection ? `.${tab.collection}` : ''}
        </span>
      )}
      <button
        type="button"
        onClick={toggle}
        disabled={forceReadOnly || envLocked}
        title={
          forceReadOnly
            ? 'FORCE_READ_ONLY is set on this LiteMongo server'
            : envLocked
              ? `${style.label} connections are always read-only`
              : 'Toggle Read-Only lock'
        }
        className={`ml-auto flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-semibold ${locked ? 'bg-black/35' : 'bg-white text-red-700'} disabled:cursor-not-allowed`}
      >
        {locked ? '🔒 READ-ONLY' : '🔓 WRITES ENABLED'}
        {forceReadOnly ? ' (server)' : envLocked ? ` (${style.label})` : ''}
      </button>
    </div>
  );
}
