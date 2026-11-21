import { createContext, useContext } from 'react';
import type { QueryTab, ViewMode } from './useTabStore';

/** Whether `code` badges are on for a view mode in a tab (default: on). */
export function badgesOn(tab: Pick<QueryTab, 'badges'>, mode: ViewMode): boolean {
  return tab.badges?.[mode] ?? true;
}

/** Whether `code` badges render in the view below (provided by DataViewer). */
export const BadgesContext = createContext(true);
export const useBadges = () => useContext(BadgesContext);
