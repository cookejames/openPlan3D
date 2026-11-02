import { get, writable, type Readable } from 'svelte/store';
import { readProject } from '$lib/utils/projectValidation';
import type { Project } from '$lib/models/types';
import type { CloudProjectMeta, CloudStore } from './cloudStore';
import { ProjectConflictError, type DataStore, type LocalDataStore } from './datastore';
import { readRecord, type CloudSyncMeta } from './localDatabase';

export type SyncStatus = 'local' | 'synced' | 'syncing' | 'offline' | 'conflict' | 'error' | 'cloud';
// 'cloud' = in the cloud, not yet in this browser.

export type CloudMetaInfo = { ownerUid: string; isOwner: boolean; updatedBy: string };

export interface SyncStore extends DataStore {
  syncStatus: Readable<Record<string, SyncStatus>>;
  /** Ownership info for cloud projects seen by list/load, for the library UI. */
  cloudMeta: Readable<Record<string, CloudMetaInfo>>;
  /** Discard local pending edits and take the cloud's latest revision. */
  loadLatest(id: string): Promise<Project>;
  /** Save the local version as a new local-only copy, then take the cloud's latest for the original. Returns the copy. */
  keepMineAsCopy(id: string): Promise<Project>;
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
  /** Max time cloud work may delay opening or listing a project. Default 8000. */
  cloudTimeoutMs?: number;
}

const PUSH_DELAY = 5_000;
const RETRY_DELAYS = [5_000, 15_000, 60_000, 300_000];
const KEEP_REVS = 10;
const CLOUD_TIMEOUT = 8_000;

export function createSyncStore(deps: SyncStoreDeps): SyncStore {
  const { local, cloud } = deps;
  const setTimer = deps.timers?.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.timers?.clearTimeout ?? ((handle: any) => clearTimeout(handle));
  const readLocal = deps.readLocal ?? ((id: string) => readRecord('projects', id));

  const status = writable<Record<string, SyncStatus>>({});
  const setStatus = (id: string, value: SyncStatus) => status.update(all => (all[id] === value ? all : { ...all, [id]: value }));

  const cloudInfo = writable<Record<string, CloudMetaInfo>>({});
  const noteCloud = (m: CloudProjectMeta) => {
    const info = { ownerUid: m.ownerUid, isOwner: m.ownerUid === deps.user()?.uid, updatedBy: m.updatedBy };
    cloudInfo.update(all => ({ ...all, [m.id]: info }));
  };
  const forget = (id: string) => {
    status.update(({ [id]: _s, ...rest }) => rest);
    cloudInfo.update(({ [id]: _c, ...rest }) => rest);
  };
  const offlineOrError = (): SyncStatus => (typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error');

  /** Rejects after the timeout. `cancelled()` lets the work skip side effects once the caller has moved on. */
  function withTimeout<T>(work: (cancelled: () => boolean) => Promise<T>): Promise<T> {
    let done = false;
    return new Promise<T>((resolve, reject) => {
      const handle = setTimer(() => { done = true; reject(new Error('Cloud request timed out')); }, deps.cloudTimeoutMs ?? CLOUD_TIMEOUT);
      work(() => done).then(
        v => { if (!done) { done = true; clearTimer(handle); resolve(v); } },
        e => { if (!done) { done = true; clearTimer(handle); reject(e); } },
      );
    });
  }

  /** Download, validate and adopt the cloud's latest revision, then record it as the known revision. */
  async function pullLatest(id: string, cm: CloudProjectMeta, cancelled: () => boolean = () => false) {
    const raw = await cloud!.downloadLatest(cm);
    const incoming = readProject(JSON.parse(raw));
    if (incoming.id !== id) throw new Error('The cloud project ID does not match.');
    if (cancelled()) return;
    await local.adopt(id, raw);
    await deps.meta.write(id, { knownRev: cm.rev, pendingBaseRev: null });
    conflicted.delete(id);
    failures.delete(id);
    unschedule(id);
    setStatus(id, 'synced');
  }

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

  async function loadLatest(id: string): Promise<Project> {
    if (!cloud || !deps.user()) throw new Error('Sign in to sync projects');
    const cm = await cloud.readMeta(id);
    if (!cm) throw new Error('This project is no longer available in the cloud');
    noteCloud(cm);
    await pullLatest(id, cm);
    const project = await local.load(id);
    if (!project) throw new Error('Project not found');
    return project;
  }

  return {
    ...local,
    syncStatus: { subscribe: status.subscribe },
    cloudMeta: { subscribe: cloudInfo.subscribe },
    flush,

    async load(id) {
      if (!cloud || !deps.user()) return local.load(id);
      let meta: CloudSyncMeta | null;
      try { meta = await deps.meta.read(id); } catch { return local.load(id); }
      const tracked = !!meta && meta.knownRev !== null;
      try {
        await withTimeout(async cancelled => {
          const cm = await cloud.readMeta(id);
          if (cancelled()) return;
          if (!cm) {
            if (tracked) {
              // Deleted by the owner or unshared: keep the local copy, it becomes local-only.
              await deps.meta.remove(id);
              unschedule(id);
              conflicted.delete(id);
              setStatus(id, 'local');
            }
            return;
          }
          noteCloud(cm);
          const hasLocal = (await readLocal(id)) !== null;
          if (cancelled()) return;
          if (!hasLocal) { await pullLatest(id, cm, cancelled); return; }
          // Local copy with no sync record: never overwrite it with the cloud copy.
          if (!tracked) return;
          const known = meta!.knownRev!, pending = meta!.pendingBaseRev !== null;
          if (cm.rev > known) {
            if (!pending) { await pullLatest(id, cm, cancelled); return; }
            conflicted.add(id);
            unschedule(id);
            setStatus(id, 'conflict');
            return;
          }
          if (conflicted.has(id)) { setStatus(id, 'conflict'); return; }
          if (pending) { setStatus(id, 'syncing'); schedule(id, PUSH_DELAY); }
          else setStatus(id, 'synced');
        });
      } catch {
        setStatus(id, offlineOrError());
      }
      return local.load(id);
    },

    async list() {
      const rows = await local.list();
      if (!cloud || !deps.user()) return rows;
      let remote: CloudProjectMeta[];
      try { remote = await withTimeout(() => cloud.listProjects()); } catch { return rows; }
      for (const m of remote) noteCloud(m);
      const remoteIds = new Set(remote.map(m => m.id));
      const result = [...rows];
      const have = new Set(rows.map(r => r.id));
      const current = get(status);
      for (const row of rows) {
        let meta: CloudSyncMeta | null = null;
        try { meta = await deps.meta.read(row.id); } catch { /* leave status alone */ continue; }
        if (!meta || meta.knownRev === null) { setStatus(row.id, 'local'); continue; }
        const existing = current[row.id];
        if (remoteIds.has(row.id) && !(existing === 'syncing' || existing === 'conflict' || existing === 'offline' || existing === 'error')) {
          setStatus(row.id, meta.pendingBaseRev !== null ? 'syncing' : 'synced');
        }
      }
      for (const m of remote) {
        if (have.has(m.id)) continue;
        result.push({ id: m.id, name: m.name, updatedAt: (m.updatedAt ?? new Date(0)).toISOString() });
        setStatus(m.id, 'cloud');
      }
      return result;
    },

    async delete(id) {
      if (!cloud || !deps.user()) return local.delete(id);
      const meta = await deps.meta.read(id);
      const tracked = !!meta && meta.knownRev !== null;
      let info = get(cloudInfo)[id];
      if (!info && tracked) {
        const cm = await cloud.readMeta(id);
        if (cm) { noteCloud(cm); info = get(cloudInfo)[id]; }
      }
      // Owner: remove from the cloud first; if that fails, nothing local is touched.
      if (info?.isOwner) await cloud.deleteProject(id);
      if ((await readLocal(id)) !== null) await local.delete(id);
      if (tracked) await deps.meta.remove(id);
      unschedule(id);
      conflicted.delete(id);
      failures.delete(id);
      // A non-owner only removes their local copy; the project is still shared with them, so the next
      // list() shows it again as a cloud row. That is expected.
      forget(id);
    },

    loadLatest,

    async keepMineAsCopy(id) {
      const mine = await local.load(id);
      if (!mine) throw new Error('Project not found');
      const copy = await local.saveCopy(mine, 'My version');
      await loadLatest(id);
      return copy;
    },

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
