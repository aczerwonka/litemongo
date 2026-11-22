import { toast } from '../components/ui';
import { contextFor, type ConnectionProfile } from '../store/useConnectionStore';
import { useSessionStore } from '../store/useSessionStore';
import { useTabStore } from '../store/useTabStore';
import { api, defaultDbFromUri } from './api';
import { queryClient } from './queryClient';

/** Cached queries (databases, collections, results…) that belong to one connection. */
function dropCache(profileId: string): void {
  queryClient.removeQueries({ predicate: (q) => JSON.stringify(q.queryKey).includes(profileId) });
}

/**
 * Connect: verify the profile against the server (ping + buildInfo), mark it
 * connected and bring its workspace forward (its last tab, or a new one).
 */
export async function connect(profile: ConnectionProfile, { show = true } = {}): Promise<boolean> {
  const { setLive, setBrowseDb, browseDb } = useSessionStore.getState();
  setLive(profile.id, { status: 'connecting' });
  try {
    const info = await api.testConnection(contextFor(profile, true));
    setLive(profile.id, { status: 'connected', serverVersion: info.serverVersion, pingMs: info.pingMs });
    const db = browseDb[profile.id] ?? info.defaultDb ?? defaultDbFromUri(profile.uri);
    if (db && browseDb[profile.id] === undefined) setBrowseDb(profile.id, db);
    if (show) useTabStore.getState().showConnection(profile.id, db);
    return true;
  } catch (err) {
    setLive(profile.id, { status: 'error', error: (err as Error).message });
    toast(`${profile.name}: ${(err as Error).message}`, 'error');
    return false;
  }
}

/**
 * Disconnect: close the server's pooled client right away, forget cached
 * results and collection lists. Tabs are kept (they show "Disconnected" until
 * you connect again); `closeTabs` closes them too.
 */
export async function disconnect(profile: ConnectionProfile, { closeTabs = false } = {}): Promise<void> {
  useSessionStore.getState().setLive(profile.id, null);
  dropCache(profile.id);
  if (closeTabs) useTabStore.getState().closeConnectionTabs(profile.id);
  try {
    await api.releaseConnection(contextFor(profile, true));
  } catch {
    // Server unreachable: its idle TTL closes the client anyway.
  }
}

/** After a profile was edited: a connected profile whose URI changed reconnects. */
export async function reconnectIfChanged(before: ConnectionProfile, after: ConnectionProfile): Promise<void> {
  if (before.uri === after.uri) return;
  if (useSessionStore.getState().live[before.id]?.status !== 'connected') return;
  await disconnect(before);
  await connect(after, { show: false });
}
