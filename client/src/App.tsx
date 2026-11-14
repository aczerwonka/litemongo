import { useEffect } from 'react';
import { ImportExportModal, useTransferModal } from './components/ImportExportModal';
import { QueryWorkspace } from './components/QueryWorkspace';
import { SchemaManager } from './components/SchemaManager';
import { ShortcutHelp } from './components/ShortcutHelp';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { Button, Toaster, useServerInfo } from './components/ui';
import { useHotkeys, type Hotkeys } from './hooks/useHotkeys';
import { useActiveTab, useTabStore } from './store/useTabStore';
import { nextThemeMode, useResolvedTheme, useThemeStore, type ThemeMode } from './store/useThemeStore';
import { useUiStore } from './store/useUiStore';
import { useWorkspaceStore } from './store/useWorkspaceStore';

const THEME_LABEL: Record<ThemeMode, string> = { system: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };

export default function App() {
  const workspaceName = useWorkspaceStore((s) => s.config.workspaceName);
  const openTransfer = useTransferModal((s) => s.open);
  const openSchema = useUiStore((s) => s.openSchema);
  const setHelpOpen = useUiStore((s) => s.setHelpOpen);
  const server = useServerInfo();
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const theme = useResolvedTheme();
  const tab = useActiveTab();

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

  const stepTab = (direction: 1 | -1) => {
    const { tabs, activeId, setActive } = useTabStore.getState();
    const i = tabs.findIndex((t) => t.id === activeId);
    const next = tabs[(i + direction + tabs.length) % tabs.length];
    if (next) setActive(next.id);
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
  };
  for (let n = 1; n <= 9; n++) {
    hotkeys[`alt+Digit${n}`] = () => {
      const { tabs, setActive } = useTabStore.getState();
      const target = tabs[n - 1];
      if (target) setActive(target.id);
    };
  }
  useHotkeys(hotkeys);

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-3 py-2">
        <span className="font-semibold tracking-tight">
          <span className="text-emerald-400">Lite</span>Mongo
        </span>
        <span className="truncate text-sm text-zinc-500">{workspaceName}</span>
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
