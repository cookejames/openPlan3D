import { derived, get, writable, type Readable } from 'svelte/store';
import { authState } from './auth';
import { currentProject, loadProject } from './project';
import { autoSave, markClean, saveState } from './saveStatus';
import { readOnlyReason, setEditLockReadOnly } from './readOnly';
import { projectStore } from '$lib/services/projectStore';
import { cloudStore, type CloudStore, type PresenceEntry } from '$lib/services/cloudStore';
import { storageErrorMessage } from '$lib/services/datastore';
import type { Project } from '$lib/models/types';

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 120_000;
export const FIRST_SNAPSHOT_TIMEOUT_MS = 3_000;

export type { PresenceEntry };
export type PresenceApi = Pick<CloudStore, 'writePresence' | 'removePresence' | 'watchPresence'>;

/** One random id per tab. */
export const sessionId = crypto.randomUUID();

const isLive = (e: PresenceEntry, now: number) => e.lastSeen === null || now - e.lastSeen.getTime() <= STALE_MS;
// A null claimedAt means the doc never claimed (pending claims are estimated by the store), so it is the oldest.
const claimTime = (e: PresenceEntry) => (e.claimedAt ? e.claimedAt.getTime() : -Infinity);

/** Live editing sessions, newest claim first (ties: larger session id first). */
export function liveEditors(entries: PresenceEntry[], now: number): PresenceEntry[] {
  return entries
    .filter(e => e.mode === 'editing' && isLive(e, now))
    .sort((a, b) => {
      const d = claimTime(b) - claimTime(a);
      if (d !== 0 && !Number.isNaN(d)) return d;
      return a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0;
    });
}
export const lockHolder = (entries: PresenceEntry[], now: number) => liveEditors(entries, now)[0] ?? null;

export interface EditLockState {
  phase: 'off' | 'checking' | 'editing' | 'locked';
  /** In locked view: why. 'held' = someone is editing, 'tookOver' = they took over from us, 'finished' = holder is gone. */
  notice: 'held' | 'tookOver' | 'finished' | null;
  holderEmail: string | null;
  /** True when the holder is another session of the signed-in user. */
  holderIsSelf: boolean;
  busy: boolean;
  error: string | null;
}
const initial: EditLockState = { phase: 'off', notice: null, holderEmail: null, holderIsSelf: false, busy: false, error: null };
const stateInner = writable<EditLockState>(initial);
export const editLockState: Readable<EditLockState> = { subscribe: stateInner.subscribe };

export interface LockSource {
  user: { uid: string } | null;
  projectId: string | null;
  cloudTracked: boolean;
  shareView: boolean;
}

export interface EditLockDeps {
  presence: PresenceApi | null;
  now(): number;
  sessionId: string;
  save(): Promise<unknown>;
  flush(id: string): Promise<void>;
  loadLatest(id: string): Promise<Project>;
  loadProject(p: Project): void;
  markClean(): void;
  setReadOnly(value: boolean): void;
}

export function createEditLock(deps: EditLockDeps, state = stateInner) {
  let key = '';
  let user: LockSource['user'] = null;
  let pid: string | null = null;
  let unwatch: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let latest: PresenceEntry[] = [];
  let mode: 'editing' | 'viewing' = 'editing';
  let tookOver = false;
  let transitioning = false;
  let gen = 0;
  let firstSnapshot = false;
  /** Our presence doc was removed (pagehide); any write must re-enter through a fresh evaluation. */
  let removed = false;
  /** Released for sign-out: stay inactive for this user until the user changes. */
  let releasedUid: string | null = null;

  const patch = (p: Partial<EditLockState>) => state.update(s => ({ ...s, ...p }));
  const others = () => liveEditors(latest.filter(e => e.sessionId !== deps.sessionId), deps.now());
  const write = (m: 'editing' | 'viewing', claim: boolean) => {
    if (!deps.presence || !pid) return Promise.resolve();
    return deps.presence.writePresence(pid, deps.sessionId, { mode: m, claim });
  };

  function describeHolder() {
    const holder = lockHolder(latest.filter(e => e.sessionId !== deps.sessionId), deps.now());
    patch({ holderEmail: holder?.email ?? null, holderIsSelf: !!holder && !!user && holder.uid === user.uid });
    return holder;
  }

  function refreshLocked() {
    const holder = describeHolder();
    patch({ notice: !holder ? 'finished' : tookOver ? 'tookOver' : 'held' });
  }

  async function enterLocked(becauseTookOver: boolean) {
    tookOver = becauseTookOver;
    mode = 'viewing';
    deps.setReadOnly(true);
    patch({ phase: 'locked', error: null });
    refreshLocked();
    try { await write('viewing', false); } catch { /* heartbeat retries */ }
  }

  async function takeover() {
    if (transitioning) return;
    transitioning = true;
    const id = pid;
    try {
      // Nothing may be lost: persist locally and push before the editor turns read-only.
      try { await deps.save(); if (id) await deps.flush(id); } catch { /* conflicts surface via the existing banner */ }
      if (id !== pid) return;
      await enterLocked(true);
    } finally { transitioning = false; }
  }

  function evaluate() {
    if (!pid || transitioning) return;
    const s = get(state);
    if (s.phase === 'editing') {
      const holder = lockHolder(latest, deps.now());
      if (holder && holder.sessionId !== deps.sessionId) void takeover();
    } else if (s.phase === 'locked') {
      if (!s.busy) refreshLocked();
    }
  }

  async function begin(id: string) {
    const my = ++gen;
    removed = false;
    firstSnapshot = false;
    latest = [];
    tookOver = false;
    mode = 'editing';
    patch({ ...initial, phase: 'checking' });
    let resolveFirst!: () => void;
    const first = new Promise<void>(r => { resolveFirst = r; });
    unwatch = deps.presence!.watchPresence(id, entries => {
      if (my !== gen) return;
      latest = entries;
      if (!firstSnapshot) { firstSnapshot = true; resolveFirst(); } else evaluate();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([first, new Promise<void>(r => { timer = setTimeout(r, FIRST_SNAPSHOT_TIMEOUT_MS); })]);
    clearTimeout(timer);
    if (my !== gen) return;
    heartbeat = setInterval(() => {
      if (removed) { restart(); return; }
      void write(mode, false).catch(() => {});
      evaluate();
    }, HEARTBEAT_MS);
    if (others().length > 0) {
      await enterLocked(false);
    } else {
      deps.setReadOnly(false);
      patch({ phase: 'editing' });
      try { await write('editing', true); } catch { /* heartbeat retries; editing continues */ }
    }
  }

  /** Re-run the open evaluation (resubscribe, then view or claim) without removing presence first. */
  function restart() {
    const id = pid;
    if (!id) return;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    unwatch?.();
    unwatch = null;
    transitioning = false;
    void begin(id);
  }

  /** Stop heartbeat and subscription, remove our presence (best effort) and restore editability. */
  function end(): Promise<void> {
    gen++;
    const id = pid;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    unwatch?.();
    unwatch = null;
    const removal = id && deps.presence ? deps.presence.removePresence(id, deps.sessionId).catch(() => {}) : Promise.resolve();
    pid = null;
    transitioning = false;
    deps.setReadOnly(false);
    state.set(initial);
    return removal;
  }

  return {
    /** Re-target on any change of user / project / tracking / share view. */
    update(source: LockSource) {
      if (releasedUid !== null && source.user?.uid !== releasedUid) releasedUid = null;
      const active = releasedUid === null && !!deps.presence && !!source.user && !!source.projectId && source.cloudTracked && !source.shareView;
      const next = active ? `${source.user!.uid}|${source.projectId}` : '';
      if (next === key) return;
      if (key) void end();
      key = next;
      if (!next) return;
      user = source.user;
      pid = source.projectId;
      void begin(pid!);
    },
    /** Take the lock: load the newest version first, then claim and become editable. */
    async editAnyway(): Promise<boolean> {
      const id = pid;
      if (!id || get(state).phase !== 'locked' || get(state).busy) return false;
      patch({ busy: true, error: null });
      try {
        const project = await deps.loadLatest(id);
        if (id !== pid) return false;
        deps.loadProject(project);
        deps.markClean();
        await write('editing', true);
        if (id !== pid) return false;
        mode = 'editing';
        tookOver = false;
        deps.setReadOnly(false);
        patch({ phase: 'editing', notice: null, holderEmail: null, holderIsSelf: false, busy: false });
        return true;
      } catch (error) {
        patch({ busy: false, error: storageErrorMessage(error) });
        return false;
      }
    },
    /** Heartbeat now and re-evaluate (tab became visible). */
    onVisible() {
      if (!pid) return;
      if (removed) { restart(); return; }
      void write(mode, false).catch(() => {});
      evaluate();
    },
    /** Best-effort removal when the page is going away; the session keeps running if it is restored. */
    onPageHide() {
      if (pid && deps.presence) removed = true;
      if (pid && deps.presence) void deps.presence.removePresence(pid, deps.sessionId).catch(() => {});
    },
    /** Restored from the back/forward cache: presence was removed on pagehide, so re-evaluate and claim or view. */
    onPageShow(persisted: boolean) { if (persisted && pid) restart(); },
    dispose() { if (key) void end(); key = ''; },
    /** Remove our presence while still signed in (sign-out), and stay inactive until the user changes. */
    async release() {
      releasedUid = user?.uid ?? null;
      if (!key) return;
      key = '';
      await end();
    },
    isActive: () => key !== '',
  };
}

/** Wires the lock to the real stores and browser events; returns a stop function. */
export function startEditLock(): () => void {
  const lock = createEditLock({
    presence: cloudStore,
    now: () => Date.now(),
    sessionId,
    // Only real edits are saved: a save of unchanged bytes would push a revision the new holder just loaded past, and its next save would conflict.
    save: () => (get(saveState) === 'saved' ? Promise.resolve(true) : autoSave()),
    flush: id => projectStore.flush(id),
    loadLatest: id => projectStore.loadLatest(id),
    loadProject,
    markClean,
    setReadOnly: setEditLockReadOnly,
  });
  const source = derived([authState, currentProject, projectStore.cloudMeta, readOnlyReason],
    ([a, p, meta, reason]): LockSource => ({
      user: a.status === 'signedIn' ? { uid: a.user.uid } : null,
      projectId: p?.id ?? null,
      cloudTracked: !!p && !!meta[p.id],
      shareView: reason === 'share',
    }));
  const stop = source.subscribe(s => lock.update(s));
  const onVis = () => { if (document.visibilityState === 'visible') lock.onVisible(); };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', lock.onPageHide);
  const onShow = (e: PageTransitionEvent) => lock.onPageShow(e.persisted);
  window.addEventListener('pageshow', onShow);
  currentEditLock = lock;
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pagehide', lock.onPageHide);
    window.removeEventListener('pageshow', onShow);
    lock.dispose();
    if (currentEditLock === lock) currentEditLock = null;
  };
}

let currentEditLock: ReturnType<typeof createEditLock> | null = null;
export const editAnyway = () => currentEditLock?.editAnyway() ?? Promise.resolve(false);
export const releaseEditLock = () => currentEditLock?.release() ?? Promise.resolve();
