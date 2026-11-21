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
  /** Replica set name (`replicaSet=`); empty = not set. */
  replicaSet: string;
  /** `directConnection=`: '' = driver default (auto), 'true' = this one host only, 'false' = discover the topology. */
  directConnection: '' | 'true' | 'false';
  /** `readPreference=`; empty = driver default (primary). */
  readPreference: '' | ReadPreferenceMode;
  /** `tlsAllowInvalidCertificates=true` (self-signed certificates). */
  tlsAllowInvalidCertificates: boolean;
  /** Any other URI options, `key=value&key2=value2`. */
  options: string;
}

export const READ_PREFERENCES = ['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'] as const;
export type ReadPreferenceMode = (typeof READ_PREFERENCES)[number];

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

/**
 * Pre-filled profile for local development: the docker-compose MongoDB
 * (`docker compose up -d`). Offered in `vite dev` and in the Electron desktop
 * app (always the developer's own machine), or when a build sets
 * VITE_DEFAULT_MONGO_URI explicitly. The jump-host container (a browser on
 * another machine) never gets one.
 */
const DOCKER_DEV_URI = 'mongodb://admin:localpassword@localhost:27017/insurance_dev?authSource=admin';
const IS_DESKTOP = typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent);
const DEFAULT_URI: string | undefined =
  import.meta.env.VITE_DEFAULT_MONGO_URI || (import.meta.env.DEV || IS_DESKTOP ? DOCKER_DEV_URI : undefined);

export const DEFAULT_PROFILE: ConnectionProfile | null = DEFAULT_URI
  ? { id: 'default-local-docker', name: 'Local Docker Dev', uri: DEFAULT_URI, env: 'local', readOnly: false }
  : null;

interface ConnectionState {
  profiles: ConnectionProfile[];
  /** The default profile was offered once; deleting it keeps it deleted. */
  defaultSeeded?: boolean;
  upsert: (profile: ConnectionProfile) => void;
  remove: (id: string) => void;
  setReadOnly: (id: string, readOnly: boolean) => void;
}

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set) => ({
      profiles: DEFAULT_PROFILE ? [DEFAULT_PROFILE] : [],
      defaultSeeded: !!DEFAULT_PROFILE,
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
      // Existing browsers (stored state from before the default existed) get it once too.
      onRehydrateStorage: () => (state) => {
        if (!state || !DEFAULT_PROFILE || state.defaultSeeded) return;
        const has = state.profiles.some((p) => p.id === DEFAULT_PROFILE.id || p.uri === DEFAULT_PROFILE.uri);
        useConnectionStore.setState({ profiles: has ? state.profiles : [DEFAULT_PROFILE, ...state.profiles], defaultSeeded: true });
      },
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
  if (p.replicaSet?.trim()) query.set('replicaSet', p.replicaSet.trim());
  // The driver rejects directConnection=true with mongodb+srv.
  if (p.directConnection && !(p.srv && p.directConnection === 'true')) query.set('directConnection', p.directConnection);
  if (p.readPreference) query.set('readPreference', p.readPreference);
  if (p.tlsAllowInvalidCertificates && (p.tls || p.srv)) query.set('tlsAllowInvalidCertificates', 'true');
  for (const [k, v] of new URLSearchParams((p.options ?? '').trim().replace(/^[?&]+/, ''))) {
    if (k.trim() && !query.has(k.trim())) query.set(k.trim(), v.trim());
  }
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
    replicaSet: query.get('replicaSet') ?? '',
    directConnection: ((v) => (v === 'true' || v === 'false' ? v : ''))(query.get('directConnection')),
    readPreference: ((v) => ((READ_PREFERENCES as readonly string[]).includes(v ?? '') ? (v as ReadPreferenceMode) : ''))(query.get('readPreference')),
    tlsAllowInvalidCertificates: query.get('tlsAllowInvalidCertificates') === 'true' || query.get('tlsInsecure') === 'true',
    options: otherOptions(query),
  };
}

const FORM_OPTIONS = new Set(['authSource', 'tls', 'ssl', 'replicaSet', 'directConnection', 'readPreference', 'tlsAllowInvalidCertificates', 'tlsInsecure']);

/** URI options the form has no dedicated field for, as `key=value&…`. */
function otherOptions(query: URLSearchParams): string {
  const rest = new URLSearchParams();
  for (const [k, v] of query) if (!FORM_OPTIONS.has(k)) rest.append(k, v);
  return rest.toString();
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
  replicaSet: '',
  directConnection: '',
  readPreference: '',
  tlsAllowInvalidCertificates: false,
  options: '',
};

/** Profiles saved before a field existed get its default. */
export function withParamDefaults(params: Partial<ConnectionParams> | undefined): ConnectionParams {
  return { ...DEFAULT_PARAMS, ...params };
}

export function isSrvUri(uri: string): boolean {
  return /^mongodb\+srv:\/\//i.test(uri.trim());
}

/** Value of one option in a connection string's query, or null. */
export function uriOption(uri: string, key: string): string | null {
  const q = uri.indexOf('?');
  return q < 0 ? null : new URLSearchParams(uri.slice(q + 1)).get(key);
}

/** Set (or remove, with null) one option in a connection string, keeping the rest as typed. */
export function setUriOption(uri: string, key: string, value: string | null): string {
  const trimmed = uri.trim();
  const q = trimmed.indexOf('?');
  const base = q < 0 ? trimmed : trimmed.slice(0, q);
  const parts = (q < 0 ? '' : trimmed.slice(q + 1)).split('&').filter((p) => p && p.split('=')[0] !== key);
  if (value !== null) parts.push(`${key}=${encodeURIComponent(value)}`);
  // mongodb://host?x=1 is invalid: the driver needs the "/" before the options.
  const withSlash = parts.length && !/^mongodb(\+srv)?:\/\/[^/]+\//i.test(base) ? `${base}/` : base;
  return parts.length ? `${withSlash}?${parts.join('&')}` : base;
}
