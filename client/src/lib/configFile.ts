import { create } from 'zustand';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import type { WorkspaceConfig } from '../types';
import { downloadText } from './clipboard';
import { validateConfigText } from './configValidation';

/**
 * litemongo.config.json on disk. Where the browser supports the File System
 * Access API (Chrome, Edge, the desktop app) the chosen file is remembered
 * (IndexedDB) and every workspace change (new links, schemas, badges…) is
 * written back to it automatically. Elsewhere "Save" downloads the file.
 */

type Permission = 'granted' | 'denied' | 'prompt';
interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  queryPermission?(opts: { mode: 'readwrite' }): Promise<Permission>;
  requestPermission?(opts: { mode: 'readwrite' }): Promise<Permission>;
}
interface PickerOpts {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
interface FsWindow {
  showSaveFilePicker?: (opts?: PickerOpts) => Promise<FileHandle>;
  showOpenFilePicker?: (opts?: PickerOpts) => Promise<FileHandle[]>;
}

const fsWindow = window as unknown as FsWindow;
export const fileAccessSupported = typeof fsWindow.showSaveFilePicker === 'function';

const PICKER: PickerOpts = {
  suggestedName: 'litemongo.config.json',
  types: [{ description: 'LiteMongo workspace config', accept: { 'application/json': ['.json'] } }],
};

// --- remembered handle (IndexedDB: handles are structured-cloneable, not JSON) ---

const DB_NAME = 'litemongo';
const STORE = 'handles';
const KEY = 'config';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDo<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  try {
    const db = await idb();
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined; // storage blocked: the file just is not remembered
  }
}
const loadHandle = () => idbDo<FileHandle>('readonly', (s) => s.get(KEY));
const storeHandle = (h: FileHandle | null) => idbDo('readwrite', (s) => (h ? s.put(h, KEY) : s.delete(KEY)));

// --- status ---

interface ConfigFileState {
  /** Linked file name, or null. */
  fileName: string | null;
  /** Workspace changed since the last write to the file (or no file yet). */
  dirty: boolean;
  savedAt: number | null;
  error: string | null;
}
export const useConfigFile = create<ConfigFileState>(() => ({ fileName: null, dirty: false, savedAt: null, error: null }));

let handle: FileHandle | null = null;
const pretty = (c: WorkspaceConfig) => `${JSON.stringify(c, null, 2)}\n`;

async function hasPermission(h: FileHandle, ask: boolean): Promise<boolean> {
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return ask && !!h.requestPermission && (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

async function writeTo(h: FileHandle, config: WorkspaceConfig): Promise<void> {
  const w = await h.createWritable();
  await w.write(pretty(config));
  await w.close();
  useConfigFile.setState({ fileName: h.name, dirty: false, savedAt: Date.now(), error: null });
}

/**
 * Save the workspace config to its file. Asks for a file the first time (or
 * with `chooseNew`); falls back to a download where the API is missing.
 * Must run from a click (permission prompts need a user gesture).
 */
export async function saveConfigFile(chooseNew = false): Promise<string | null> {
  const config = useWorkspaceStore.getState().config;
  if (!fileAccessSupported) {
    downloadText('litemongo.config.json', pretty(config));
    useConfigFile.setState({ dirty: false, savedAt: Date.now(), error: null });
    return 'litemongo.config.json (downloaded)';
  }
  try {
    if (!handle || chooseNew) {
      handle = await (fsWindow.showSaveFilePicker as NonNullable<FsWindow['showSaveFilePicker']>)(PICKER);
      await storeHandle(handle);
    }
    if (!(await hasPermission(handle, true))) throw new Error(`No permission to write ${handle.name}`);
    await writeTo(handle, config);
    return handle.name;
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null; // picker cancelled
    useConfigFile.setState({ error: (err as Error).message });
    throw err;
  }
}

/** Load a config file, apply it, and keep it linked for auto-save. */
export async function openConfigFile(): Promise<string | null> {
  if (!fsWindow.showOpenFilePicker) return null;
  try {
    const [picked] = await fsWindow.showOpenFilePicker(PICKER);
    if (!picked) return null;
    const result = validateConfigText(await (await picked.getFile()).text());
    if (!result.ok) {
      throw new Error(result.issues.find((i) => i.severity === 'error')?.message ?? 'Invalid config file');
    }
    handle = picked;
    await storeHandle(picked);
    suppressNext = true;
    useWorkspaceStore.getState().setConfig(result.parsed as WorkspaceConfig);
    useConfigFile.setState({ fileName: picked.name, dirty: false, savedAt: Date.now(), error: null });
    return picked.name;
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null;
    throw err;
  }
}

/** Forget the linked file (the workspace stays as it is in this browser). */
export async function unlinkConfigFile(): Promise<void> {
  handle = null;
  await storeHandle(null);
  useConfigFile.setState({ fileName: null, dirty: true, savedAt: null, error: null });
}

let suppressNext = false;
let timer: number | undefined;
let started = false;

/** Restore the linked file and write every workspace change to it (debounced). Call once at startup. */
export function startConfigAutosave(): void {
  if (started) return;
  started = true;
  void loadHandle().then((h) => {
    if (h && !handle) {
      handle = h;
      useConfigFile.setState({ fileName: h.name });
    }
  });
  useWorkspaceStore.subscribe((state, prev) => {
    if (state.config === prev.config) return;
    if (suppressNext) {
      suppressNext = false;
      return;
    }
    useConfigFile.setState({ dirty: true });
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const h = handle;
      // Without permission (e.g. after a restart) wait for the user to click Save.
      if (!h || !(await hasPermission(h, false))) return;
      try {
        await writeTo(h, useWorkspaceStore.getState().config);
      } catch (err) {
        useConfigFile.setState({ error: (err as Error).message });
      }
    }, 600);
  });
}
