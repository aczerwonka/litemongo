import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ConnectionContext } from '../lib/api';

/**
 * Browser-only connection profiles. They live in this browser's localStorage and
 * are sent to the stateless server per request (X-Mongo-URI / X-Read-Only).
 * The server never stores them.
 */

/**
 * Environment of a connection. PROD and CLIENT are always read-only (red);
 * TEST is orange; DEV and LOCAL are green.
 */
export type EnvKind = 'prod' | 'client' | 'test' | 'dev' | 'local';

export const ENV_KINDS: EnvKind[] = ['prod', 'client', 'test', 'dev', 'local'];

/** Fields of the "Parameters" connection form (the URI is built from these). */
export interface ConnectionParams {
  srv: boolean;
  host: string;
  port: string;
  username: string;
  password: string;
  authSource: string;
  database: string;
  tls: boolean;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  uri: string;
  env: EnvKind;
  readOnly: boolean;
  /** Present when the profile was created with the parameter form. */
  params?: ConnectionParams;
}

interface EnvStyle {
  label: string;
  /** Always read-only: the lock cannot be opened for this environment. */
  locked: boolean;
  banner: string;
  dot: string;
  text: string;
  border: string;
}

const RED = { banner: 'bg-red-700', dot: 'bg-red-500', text: 'text-red-400', border: 'border-red-600' };
const ORANGE = { banner: 'bg-orange-600', dot: 'bg-orange-400', text: 'text-orange-300', border: 'border-orange-500' };
const GREEN = { banner: 'bg-emerald-700', dot: 'bg-emerald-500', text: 'text-emerald-400', border: 'border-emerald-600' };

export const ENV_STYLES: Record<EnvKind, EnvStyle> = {
  prod: { label: 'PROD', locked: true, ...RED },
  client: { label: 'CLIENT', locked: true, ...RED },
  test: { label: 'TEST', locked: false, ...ORANGE },
  dev: { label: 'DEV', locked: false, ...GREEN },
  local: { label: 'LOCAL', locked: false, ...GREEN },
};

/** PROD / CLIENT connections can never write. */
export function isLockedEnv(env: EnvKind): boolean {
  return ENV_STYLES[env]?.locked ?? true;
}

interface ConnectionState {
  profiles: ConnectionProfile[];
  upsert: (profile: ConnectionProfile) => void;
  remove: (id: string) => void;
  setReadOnly: (id: string, readOnly: boolean) => void;
}

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set) => ({
      profiles: [],
      upsert: (profile) =>
        set((s) => {
          const exists = s.profiles.some((p) => p.id === profile.id);
          return {
            profiles: exists ? s.profiles.map((p) => (p.id === profile.id ? profile : p)) : [...s.profiles, profile],
          };
        }),
      remove: (id) => set((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) })),
      setReadOnly: (id, readOnly) =>
        set((s) => ({
          profiles: s.profiles.map((p) => (p.id === id ? { ...p, readOnly: readOnly || isLockedEnv(p.env) } : p)),
        })),
    }),
    {
      name: 'litemongo.connections',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      // v1 stored a free color tag; v2 stores the environment kind.
      migrate: (persisted) => {
        const state = persisted as { profiles?: (Partial<ConnectionProfile> & { color?: string })[] };
        const fromColor: Record<string, EnvKind> = { red: 'prod', amber: 'test', blue: 'test', green: 'local', slate: 'dev' };
        return {
          profiles: (state.profiles ?? []).map(({ color, ...p }) => {
            const env = p.env ?? fromColor[color ?? ''] ?? 'dev';
            return { ...p, env, readOnly: !!p.readOnly || isLockedEnv(env) } as ConnectionProfile;
          }),
        };
      },
    },
  ),
);

export function useProfile(id: string | null | undefined): ConnectionProfile | undefined {
  return useConnectionStore((s) => (id ? s.profiles.find((p) => p.id === id) : undefined));
}

/**
 * Request context for a profile. `forceReadOnly` (server-wide FORCE_READ_ONLY)
 * and PROD / CLIENT environments always win; the server enforces it too, this just keeps the UI honest.
 */
export function contextFor(profile: ConnectionProfile, forceReadOnly = false): ConnectionContext {
  return { uri: profile.uri, readOnly: forceReadOnly || profile.readOnly || isLockedEnv(profile.env) };
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Build a MongoDB connection string from the parameter form. */
export function buildUri(p: ConnectionParams): string {
  const enc = encodeURIComponent;
  const auth = p.username ? `${enc(p.username)}${p.password ? `:${enc(p.password)}` : ''}@` : '';
  const hosts = p.host
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => (p.srv || h.includes(':') || !p.port.trim() ? h : `${h}:${p.port.trim()}`))
    .join(',');
  const query = new URLSearchParams();
  if (p.username && p.authSource.trim()) query.set('authSource', p.authSource.trim());
  if (p.tls && !p.srv) query.set('tls', 'true');
  const qs = query.toString();
  return `mongodb${p.srv ? '+srv' : ''}://${auth}${hosts || 'localhost'}/${enc(p.database.trim())}${qs ? `?${qs}` : ''}`;
}

/** Best-effort reverse of buildUri (for switching an existing URI to the form). */
export function parseUri(uri: string): ConnectionParams | null {
  const m = /^mongodb(\+srv)?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?]+)\/?([^?]*)(?:\?(.*))?$/i.exec(uri.trim());
  if (!m) return null;
  const [, srv, user, pass, hostPart, dbPart, qs] = m;
  const query = new URLSearchParams(qs ?? '');
  const hosts = (hostPart ?? '').split(',');
  const single = hosts.length === 1 ? /^(.*?)(?::(\d+))?$/.exec(hosts[0] as string) : null;
  const dec = (v: string | undefined) => {
    try {
      return decodeURIComponent(v ?? '');
    } catch {
      return v ?? '';
    }
  };
  return {
    srv: !!srv,
    host: single ? (single[1] as string) : (hostPart as string),
    port: single?.[2] ?? (srv ? '' : '27017'),
    username: dec(user),
    password: dec(pass),
    authSource: query.get('authSource') ?? (user ? 'admin' : ''),
    database: dec(dbPart),
    tls: query.get('tls') === 'true' || query.get('ssl') === 'true',
  };
}

export const DEFAULT_PARAMS: ConnectionParams = {
  srv: false,
  host: 'localhost',
  port: '27017',
  username: '',
  password: '',
  authSource: 'admin',
  database: '',
  tls: false,
};
