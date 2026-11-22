import { useEffect } from 'react';
import { ImportExportModal, useTransferModal } from './components/ImportExportModal';
import { QueryWorkspace } from './components/QueryWorkspace';
import { SchemaManager } from './components/SchemaManager';
import { ShortcutHelp } from './components/ShortcutHelp';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { Button, Toaster, useServerInfo } from './components/ui';
import { useHotkeys, type Hotkeys } from './hooks/useHotkeys';
import { useActiveTab, useTabStore, visibleTabs } from './store/useTabStore';
import { DEFAULT_PROFILE, useConnectionStore } from './store/useConnectionStore';
import { defaultDbFromUri } from './lib/api';
import { nextThemeMode, useResolvedTheme, useThemeStore, type ThemeMode } from './store/useThemeStore';
import { useUiStore } from './store/useUiStore';
import { saveConfigFile, startConfigAutosave, useConfigFile } from './lib/configFile';
import { toast } from './components/ui';

const THEME_LABEL: Record<ThemeMode, string> = { system: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };

export default function App() {
  const openTransfer = useTransferModal((s) => s.open);
  const openSchema = useUiStore((s) => s.openSchema);
  const setHelpOpen = useUiStore((s) => s.setHelpOpen);
  const server = useServerInfo();
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const theme = useResolvedTheme();
  const tab = useActiveTab();
  const configFile = useConfigFile();

  useEffect(() => startConfigAutosave(), []);

  // Dev convenience: tabs without a connection start on the pre-filled local Docker profile.
  useEffect(() => {
    const profile = DEFAULT_PROFILE && useConnectionStore.getState().profiles.find((p) => p.id === DEFAULT_PROFILE?.id || p.uri === DEFAULT_PROFILE?.uri);
    if (!profile) return;
    const { tabs, updateTab } = useTabStore.getState();
    for (const t of tabs) {
      if (!t.connectionId) updateTab(t.id, { connectionId: profile.id, db: t.db ?? defaultDbFromUri(profile.uri) });
    }
  }, []);

  const saveConfig = async () => {
    try {
      const name = await saveConfigFile();
      if (name) toast(`Workspace config saved to ${name}`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  useEffect(() => {
    // Swap the palette in one step: no element should animate through the other theme.
    const root = document.documentElement;
    root.classList.add('theme-switching');
    root.dataset.theme = theme;
    const timer = window.setTimeout(() => root.classList.remove('theme-switching'), 100);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#09090b' : '#fafafa');
    return () => window.clearTimeout(timer);
  }, [theme]);

  // Read the store directly so rapid presses never act on a stale render.
  const cycleTheme = () => setThemeMode(nextThemeMode(useThemeStore.getState().mode));

  // Tab hotkeys move within the active connection's tabs (the ones in the tab bar).
  const stepTab = (direction: 1 | -1) => {
    const state = useTabStore.getState();
    const tabs = visibleTabs(state);
    const i = tabs.findIndex((t) => t.id === state.activeId);
    const next = tabs[(i + direction + tabs.length) % tabs.length];
    if (next) state.setActive(next.id);
  };
  const hotkeys: Hotkeys = {
    'alt+KeyT': () => useTabStore.getState().addTab({ connectionId: tab.connectionId, db: tab.db }),
    'alt+KeyW': () => useTabStore.getState().closeTab(tab.id),
    'alt+BracketLeft': () => stepTab(-1),
    'alt+BracketRight': () => stepTab(1),
    'alt+KeyD': cycleTheme,
    'alt+KeyS': () => openSchema(tab.collection),
    'key:?': () => setHelpOpen(true),
    'alt+Slash': () => setHelpOpen(true),
    'mod+KeyS': () => void saveConfig(),
  };
  for (let n = 1; n <= 9; n++) {
    hotkeys[`alt+Digit${n}`] = () => {
      const state = useTabStore.getState();
      const target = visibleTabs(state)[n - 1];
      if (target) state.setActive(target.id);
    };
  }
  useHotkeys(hotkeys);

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-3 py-2">
        <span className="font-semibold tracking-tight">
          <span className="text-emerald-400">Lite</span>Mongo
        </span>
        {server.isError && <span className="text-sm text-red-400">Server unreachable</span>}
        {server.data?.forceReadOnly && (
          <span className="rounded bg-red-900 px-1.5 py-0.5 text-xs text-red-100">Server: FORCE_READ_ONLY</span>
        )}
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" onClick={() => openSchema(tab.collection)} title="Document collection fields (Alt+S)">
            ☰ Schema
          </Button>
          <Button variant="ghost" onClick={() => openTransfer({ mode: 'paste' })}>
            ⇣ Paste data
          </Button>
          <Button
            variant="ghost"
            onClick={() => void saveConfig()}
            title={
              configFile.error
                ? `Save failed: ${configFile.error}`
                : configFile.fileName
                  ? `${configFile.dirty ? 'Unsaved changes — click to save to' : 'Saved to'} ${configFile.fileName} (Ctrl/Cmd+S)`
                  : 'Save litemongo.config.json (links, schemas, presets) to a file (Ctrl/Cmd+S)'
            }
          >
            💾 {configFile.fileName ? configFile.fileName : 'Save config'}
            {configFile.error ? <span className="text-red-400"> !</span> : configFile.dirty || !configFile.fileName ? <span className="text-amber-400"> •</span> : <span className="text-emerald-400"> ✓</span>}
          </Button>
          <Button variant="ghost" onClick={() => openTransfer({ mode: 'config' })}>
            ⚙ Workspace config
          </Button>
          <Button variant="ghost" onClick={cycleTheme} title="Theme: system → light → dark (Alt+D)" aria-label={`Theme: ${themeMode}`}>
            {THEME_LABEL[themeMode]}
          </Button>
          <Button variant="ghost" onClick={() => setHelpOpen(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
            ⌨
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <QueryWorkspace />
        </main>
      </div>
      <ImportExportModal />
      <SchemaManager />
      <ShortcutHelp />
      <Toaster />
    </div>
  );
}
