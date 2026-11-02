import { writable, type Readable } from 'svelte/store';
import type { Project } from '$lib/models/types';
import type { CloudStore } from './cloudStore';
import { ProjectConflictError, type DataStore, type LocalDataStore } from './datastore';
import { readRecord, type CloudSyncMeta } from './localDatabase';

export type SyncStatus = 'local' | 'synced' | 'syncing' | 'offline' | 'conflict' | 'error';

export interface SyncStore extends DataStore {
  syncStatus: Readable<Record<string, SyncStatus>>;
  flush(id?: string): Promise<void>;
  uploadToCloud(id: string): Promise<void>;
  /** Clear timers and listeners. */
  dispose(): void;
}

export interface SyncStoreDeps {
  local: LocalDataStore;
  /** null = Firebase disabled: behave exactly like local. */
  cloud: CloudStore | null;
  user: () => { uid: string; email: string } | null;
  meta: {
    read(id: string): Promise<CloudSyncMeta | null>;
    write(id: string, meta: CloudSyncMeta): Promise<void>;
    remove(id: string): Promise<void>;
  };
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: any) => void;
  };
  /** Raw stored bytes of a project. Reads IndexedDB directly: DataStore.load would invalidate the editor's queued saves. */
  readLocal?: (id: string) => Promise<string | null>;
}

const PUSH_DELAY = 5_000;
const RETRY_DELAYS = [5_000, 15_000, 60_000, 300_000];
const KEEP_REVS = 10;

export function createSyncStore(deps: SyncStoreDeps): SyncStore {
  const { local, cloud } = deps;
  const setTimer = deps.timers?.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.timers?.clearTimeout ?? ((handle: any) => clearTimeout(handle));
  const readLocal = deps.readLocal ?? ((id: string) => readRecord('projects', id));

  const status = writable<Record<string, SyncStatus>>({});
  const setStatus = (id: string, value: SyncStatus) => status.update(all => (all[id] === value ? all : { ...all, [id]: value }));

  const timers = new Map<string, unknown>();
  const inFlight = new Map<string, Promise<void>>();
  const redirty = new Set<string>();
  const failures = new Map<string, number>();
  const conflicted = new Set<string>();

  const unschedule = (id: string) => {
    if (!timers.has(id)) return;
    clearTimer(timers.get(id));
    timers.delete(id);
  };
  const schedule = (id: string, delay: number) => {
    unschedule(id);
    timers.set(id, setTimer(() => { timers.delete(id); void push(id); }, delay));
  };

  function push(id: string): Promise<void> {
    unschedule(id);
    const running = inFlight.get(id);
    if (running) { redirty.add(id); return running; }
    const run = pushOnce(id).finally(() => inFlight.delete(id));
    inFlight.set(id, run);
    return run;
  }

  async function pushOnce(id: string): Promise<void> {
    if (!cloud || !deps.user()) return;
    let meta: CloudSyncMeta | null;
    try { meta = await deps.meta.read(id); } catch { return; }
    if (!meta || meta.knownRev === null) { setStatus(id, 'local'); return; }
    if (meta.pendingBaseRev === null) { if (!conflicted.has(id)) setStatus(id, 'synced'); return; }
    redirty.delete(id);
    conflicted.delete(id);
    setStatus(id, 'syncing');
    let newRev: number;
    try {
      const raw = await readLocal(id);
      if (raw === null) { setStatus(id, 'local'); return; }
      const name = (JSON.parse(raw) as Project).name;
      newRev = await cloud.pushRevision(id, meta.pendingBaseRev, raw, name);
    } catch (error) {
      if (error instanceof ProjectConflictError) {
        conflicted.add(id);
        setStatus(id, 'conflict');
        return;
      }
      const attempt = failures.get(id) ?? 0;
      failures.set(id, attempt + 1);
      setStatus(id, typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error');
      schedule(id, RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]);
      return;
    }
    failures.delete(id);
    const again = redirty.delete(id);
    try {
      await deps.meta.write(id, { knownRev: newRev, pendingBaseRev: again ? newRev : null });
    } catch {
      // The push landed; a stale base would only surface as a conflict, which the user can resolve.
    }
    if (again) { setStatus(id, 'syncing'); schedule(id, PUSH_DELAY); }
    else setStatus(id, 'synced');
    // TODO(chunk 16): share snapshot
    try { await cloud.pruneRevs(id, newRev, KEEP_REVS); } catch { /* best effort */ }
  }

  const retryNow = () => {
    for (const [id, count] of failures) if (count > 0) void push(id);
  };
  const onOnline = () => retryNow();
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') void flush();
  };
  if (cloud) {
    if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  }

  async function flush(id?: string): Promise<void> {
    if (id !== undefined) { await push(id); return; }
    await Promise.all([...new Set([...timers.keys(), ...inFlight.keys()])].map(push));
  }

  return {
    ...local,
    syncStatus: { subscribe: status.subscribe },
    flush,

    async save(project) {
      await local.save(project);
      if (!cloud || !deps.user()) return;
      const id = project.id;
      // A push is running: it may clear the pending flag as we mark it, so hand over to its follow-up.
      if (inFlight.has(id)) { redirty.add(id); return; }
      const meta = await deps.meta.read(id);
      if (!meta || meta.knownRev === null) { setStatus(id, 'local'); return; }
      if (meta.pendingBaseRev === null) await deps.meta.write(id, { knownRev: meta.knownRev, pendingBaseRev: meta.knownRev });
      if (inFlight.has(id)) { redirty.add(id); return; }
      if (conflicted.has(id)) return;
      setStatus(id, 'syncing');
      schedule(id, PUSH_DELAY);
    },

    async uploadToCloud(id) {
      if (!cloud || !deps.user()) throw new Error('Sign in to sync projects');
      const project = await local.load(id);
      if (!project) throw new Error('Project not found');
      await cloud.createProject(project);
      await deps.meta.write(id, { knownRev: 0, pendingBaseRev: null });
      setStatus(id, 'synced');
    },

    dispose() {
      for (const id of [...timers.keys()]) unschedule(id);
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
