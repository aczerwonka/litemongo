import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Live (per browser tab) connection state: which profiles are connected, and
 * the database each connection's collection list is showing. Kept in
 * sessionStorage, so a reload keeps you connected but a new browser session
 * starts disconnected (nothing hits a jump host unasked).
 */

export type ConnStatus = 'connecting' | 'connected' | 'error';

export interface LiveConnection {
  status: ConnStatus;
  error?: string;
  serverVersion?: string;
  pingMs?: number;
}

interface SessionState {
  live: Record<string, LiveConnection>;
  /** Database shown in the sidebar collection list, per connection. */
  browseDb: Record<string, string | null>;
  /** Sidebar tree: collection list folded away, per connection. */
  collapsed: Record<string, boolean>;
  setLive: (id: string, live: LiveConnection | null) => void;
  setBrowseDb: (id: string, db: string | null) => void;
  toggleCollapsed: (id: string, collapsed?: boolean) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      live: {},
      browseDb: {},
      collapsed: {},
      setLive: (id, live) =>
        set((s) => {
          const next = { ...s.live };
          if (live) next[id] = live;
          else delete next[id];
          return { live: next };
        }),
      setBrowseDb: (id, db) => set((s) => ({ browseDb: { ...s.browseDb, [id]: db } })),
      toggleCollapsed: (id, collapsed) =>
        set((s) => ({ collapsed: { ...s.collapsed, [id]: collapsed ?? !s.collapsed[id] } })),
    }),
    {
      name: 'litemongo.session',
      storage: createJSONStorage(() => sessionStorage),
      // Only finished connections survive a reload; "connecting" / errors start over.
      partialize: (s) => ({
        live: Object.fromEntries(Object.entries(s.live).filter(([, l]) => l.status === 'connected')),
        browseDb: s.browseDb,
        collapsed: s.collapsed,
      }),
    },
  ),
);

export function useLive(id: string | null | undefined): LiveConnection | undefined {
  return useSessionStore((s) => (id ? s.live[id] : undefined));
}

export function isConnected(id: string | null | undefined): boolean {
  return !!id && useSessionStore.getState().live[id]?.status === 'connected';
}
