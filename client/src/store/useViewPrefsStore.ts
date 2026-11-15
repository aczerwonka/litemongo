import { createContext, useContext } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ViewMode } from './useTabStore';

/**
 * Per-view display preferences, remembered for this browser session
 * (sessionStorage: survives reloads, cleared when the window closes).
 */
interface ViewPrefsState {
  /** `code` badges per view mode; missing = on. */
  badges: Partial<Record<ViewMode, boolean>>;
  /** Nested table: rows start unfolded ("Unfold all") or folded ("Fold all"); missing = automatic. */
  nestedUnfold: boolean | null;
  setBadges: (mode: ViewMode, on: boolean) => void;
  setNestedUnfold: (open: boolean) => void;
}

export const useViewPrefsStore = create<ViewPrefsState>()(
  persist(
    (set) => ({
      badges: {},
      nestedUnfold: null,
      setBadges: (mode, on) => set((s) => ({ badges: { ...s.badges, [mode]: on } })),
      setNestedUnfold: (nestedUnfold) => set({ nestedUnfold }),
    }),
    { name: 'litemongo.viewPrefs', version: 1, storage: createJSONStorage(() => sessionStorage) },
  ),
);

export function useBadgesOn(mode: ViewMode): boolean {
  return useViewPrefsStore((s) => s.badges[mode]) ?? true;
}

/** Whether `code` badges render in the view below (provided by DataViewer). */
export const BadgesContext = createContext(true);
export const useBadges = () => useContext(BadgesContext);
