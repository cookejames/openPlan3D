import { get, writable, type Readable } from 'svelte/store';
import { readProject } from '$lib/utils/projectValidation';
import type { Project } from '$lib/models/types';
import type { CloudProjectMeta, CloudStore } from './cloudStore';
import { ProjectConflictError, type DataStore, type LocalDataStore } from './datastore';
import { readRecord, type CloudSyncMeta } from './localDatabase';

export type SyncStatus = 'local' | 'synced' | 'syncing' | 'offline' | 'conflict' | 'error' | 'cloud';
// 'cloud' = in the cloud, not yet in this browser.

export type CloudMetaInfo = {
  ownerUid: string;
  isOwner: boolean;
  updatedBy: string;
  editorEmails: string[];
  shareToken: string | null;
};

export interface SyncStore extends DataStore {
  syncStatus: Readable<Record<string, SyncStatus>>;
  /** Ownership info for cloud projects seen by list/load, for the library UI. */
  cloudMeta: Readable<Record<string, CloudMetaInfo>>;
  /** Discard local pending edits and take the cloud's latest revision. */
  loadLatest(id: string): Promise<Project>;
  /** Save the local version as a new local-only copy, then take the cloud's latest for the original. Returns the copy. */
  keepMineAsCopy(id: string): Promise<Project>;
  flush(id?: string): Promise<void>;
  /**
   * Watch a cloud-tracked project while it is open. Calls cb only when the cloud revision is newer than this
   * browser's known revision and was written by someone other than the current user. Also refreshes cloudMeta.
   * Returns an unsubscribe; a no-op when cloud is disabled, signed out or the project is not cloud-tracked.
   */
  watch(id: string, cb: (change: { rev: number; updatedBy: string }) => void): () => void;
  /** Enter the conflict state (e.g. a remote change arrived while local edits are pending) and stop auto-push. */
  markConflict(id: string): void;
  uploadToCloud(id: string): Promise<void>;
  /** Owner only. Resolves to the stored (normalised) editor list. */
  setEditors(id: string, emails: string[]): Promise<string[]>;
  /** Flushes pending edits, then publishes a read-only snapshot. Resolves to the share token. */
  enableSharing(id: string): Promise<string>;
  disableSharing(id: string): Promise<void>;
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
const THUMB_MAX_BYTES = 200 * 1024;

/** Decodes a base64 JPEG data URL without fetch. Null when it is not base64 or is over the size limit. */
function jpegBlobFromDataUrl(dataUrl: string): Blob | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !/;base64$/i.test(dataUrl.slice(0, comma))) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  if (binary.length > THUMB_MAX_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

export function createSyncStore(deps: SyncStoreDeps): SyncStore {
  const { local, cloud } = deps;
  const setTimer = deps.timers?.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.timers?.clearTimeout ?? ((handle: any) => clearTimeout(handle));
  const readLocal = deps.readLocal ?? ((id: string) => readRecord('projects', id));

  const status = writable<Record<string, SyncStatus>>({});
  const setStatus = (id: string, value: SyncStatus) => status.update(all => (all[id] === value ? all : { ...all, [id]: value }));

  const cloudInfo = writable<Record<string, CloudMetaInfo>>({});
  const noteCloud = (m: CloudProjectMeta) => {
    const info: CloudMetaInfo = {
      ownerUid: m.ownerUid,
      isOwner: m.ownerUid === deps.user()?.uid,
      updatedBy: m.updatedBy,
      editorEmails: m.editorEmails,
      shareToken: m.shareToken,
    };
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
  /** Revisions pushed by this store instance, per project. */
  const ownRevs = new Map<string, Set<number>>();

  // Thumbnails are optional: they never touch sync status and never retry.
  const thumbTimers = new Map<string, unknown>();
  const pendingThumbs = new Map<string, string>();
  const unscheduleThumb = (id: string) => {
    if (!thumbTimers.has(id)) return;
    clearTimer(thumbTimers.get(id));
    thumbTimers.delete(id);
    pendingThumbs.delete(id);
  };

  async function uploadThumb(id: string): Promise<void> {
    const dataUrl = pendingThumbs.get(id);
    pendingThumbs.delete(id);
    if (dataUrl === undefined || !cloud) return;
    try {
      const blob = jpegBlobFromDataUrl(dataUrl);
      if (blob) await cloud.uploadThumbnail(id, blob);
    } catch {
      // Optional: a failed thumbnail upload is not a sync failure.
    }
  }

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
    let pushedRaw = '';
    try {
      const raw = await readLocal(id);
      if (raw === null) { setStatus(id, 'local'); return; }
      pushedRaw = raw;
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
    // Remember it before the meta write so a watch snapshot of our own push is never reported as remote.
    let own = ownRevs.get(id);
    if (!own) ownRevs.set(id, own = new Set());
    own.add(newRev);
    const again = redirty.delete(id);
    try {
      await deps.meta.write(id, { knownRev: newRev, pendingBaseRev: again ? newRev : null });
    } catch {
      // The push landed; a stale base would only surface as a conflict, which the user can resolve.
    }
    if (again) { setStatus(id, 'syncing'); schedule(id, PUSH_DELAY); }
    else setStatus(id, 'synced');
    // Keep the public snapshot current. The token comes from the cached cloudMeta (filled by load/list and
    // the share methods), so a push costs no extra Firestore read; if another editor enabled sharing since
    // we last looked, the snapshot catches up on the next load. Best effort: never affects sync status.
    const shareToken = get(cloudInfo)[id]?.shareToken;
    if (shareToken && !again) {
      try { await cloud.updateShareSnapshot(shareToken, pushedRaw); } catch (error) { console.warn('Could not update the share snapshot', error); }
    }
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

  /** Throws unless signed in with a cloud-tracked project; seeds cloudMeta if it was not loaded yet. */
  async function requireTracked(id: string): Promise<void> {
    if (!cloud || !deps.user()) throw new Error('Sign in to sync projects');
    const meta = await deps.meta.read(id);
    if (!meta || meta.knownRev === null) throw new Error('Upload this project to the cloud first');
    if (!get(cloudInfo)[id]) {
      const cm = await cloud.readMeta(id);
      if (!cm) throw new Error('This project is no longer available in the cloud');
      noteCloud(cm);
    }
  }

  return {
    ...local,
    syncStatus: { subscribe: status.subscribe },
    cloudMeta: { subscribe: cloudInfo.subscribe },
    flush,

    watch(id, cb) {
      if (!cloud || !deps.user()) return () => {};
      let cancelled = false;
      let stop: (() => void) | null = null;
      void (async () => {
        let meta: CloudSyncMeta | null;
        try { meta = await deps.meta.read(id); } catch { return; }
        if (cancelled || !meta || meta.knownRev === null) return;
        try {
          stop = cloud.watchProject(id, cm => {
            if (cancelled || !cm) return;
            noteCloud(cm);
            if (ownRevs.get(id)?.has(cm.rev)) return;
            void (async () => {
              // A push in flight may be the author of this snapshot: let it record its revision first.
              const running = inFlight.get(id);
              if (running) { try { await running; } catch { /* its own error handling already ran */ } }
              if (cancelled) return;
              let current: CloudSyncMeta | null;
              try { current = await deps.meta.read(id); } catch { return; }
              if (cancelled || !current || current.knownRev === null) return;
              if (cm.rev > current.knownRev && !ownRevs.get(id)?.has(cm.rev)) cb({ rev: cm.rev, updatedBy: cm.updatedBy });
            })();
          });
        } catch { return; }
        if (cancelled) { stop?.(); stop = null; }
      })();
      return () => { cancelled = true; stop?.(); stop = null; };
    },

    markConflict(id) {
      conflicted.add(id);
      unschedule(id);
      setStatus(id, 'conflict');
    },

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
      unscheduleThumb(id);
      conflicted.delete(id);
      failures.delete(id);
      // A non-owner only removes their local copy; the project is still shared with them, so the next
      // list() shows it again as a cloud row. That is expected.
      forget(id);
    },

    loadLatest,

    async saveThumbnail(id, dataUrl) {
      await local.saveThumbnail(id, dataUrl);
      if (!cloud || !deps.user()) return;
      try {
        const meta = await deps.meta.read(id);
        if (!meta || meta.knownRev === null) return;
      } catch { return; }
      pendingThumbs.set(id, dataUrl);
      if (thumbTimers.has(id)) clearTimer(thumbTimers.get(id));
      thumbTimers.set(id, setTimer(() => { thumbTimers.delete(id); void uploadThumb(id); }, PUSH_DELAY));
    },

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
      const created = await cloud.createProject(project);
      await deps.meta.write(id, { knownRev: 0, pendingBaseRev: null });
      // Fill cloudMeta now so the library offers Share… without waiting for the next list.
      if (created?.id) noteCloud(created);
      setStatus(id, 'synced');
    },

    async setEditors(id, emails) {
      await requireTracked(id);
      const list = await cloud!.setEditors(id, emails);
      cloudInfo.update(all => (all[id] ? { ...all, [id]: { ...all[id], editorEmails: list } } : all));
      return list;
    },

    async enableSharing(id) {
      await requireTracked(id);
      await push(id);
      const raw = await readLocal(id);
      if (raw === null) throw new Error('Project not found');
      const token = await cloud!.enableSharing(id, raw);
      cloudInfo.update(all => (all[id] ? { ...all, [id]: { ...all[id], shareToken: token } } : all));
      return token;
    },

    async disableSharing(id) {
      await requireTracked(id);
      await cloud!.disableSharing(id);
      cloudInfo.update(all => (all[id] ? { ...all, [id]: { ...all[id], shareToken: null } } : all));
    },

    dispose() {
      for (const id of [...timers.keys()]) unschedule(id);
      for (const id of [...thumbTimers.keys()]) unscheduleThumb(id);
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
