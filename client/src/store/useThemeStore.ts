import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** Light / dark appearance. "system" follows the OS setting. */
export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** Also read by the inline script in index.html to avoid a flash on load. */
export const THEME_STORAGE_KEY = 'litemongo.theme';

export const useThemeStore = create<{ mode: ThemeMode; setMode: (mode: ThemeMode) => void }>()(
  persist((set) => ({ mode: 'system', setMode: (mode) => set({ mode }) }), {
    name: THEME_STORAGE_KEY,
    version: 1,
    storage: createJSONStorage(() => localStorage),
  }),
);

const media = window.matchMedia('(prefers-color-scheme: light)');

function subscribeSystem(onChange: () => void): () => void {
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export function useResolvedTheme(): ResolvedTheme {
  const mode = useThemeStore((s) => s.mode);
  const systemLight = useSyncExternalStore(subscribeSystem, () => media.matches);
  if (mode === 'system') return systemLight ? 'light' : 'dark';
  return mode;
}

/** system -> light -> dark -> system */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system';
}
