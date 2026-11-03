import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';
import { createSyncStore } from '$lib/services/syncStore';
import type { LocalDataStore } from '$lib/services/datastore';
import type { CloudSyncMeta } from '$lib/services/localDatabase';
import type { CloudStore, CloudProjectMeta } from '$lib/services/cloudStore';
import { createDefaultProject } from '$lib/stores/project';
import type { Project } from '$lib/models/types';

const raw = JSON.stringify({ ...createDefaultProject('Plan'), id: 'p1' });
const cmeta = (over: Partial<CloudProjectMeta> = {}): CloudProjectMeta => ({
  id: 'p1', name: 'Cloud', ownerUid: 'u', editorEmails: ['me@x.c'], rev: 5, planPath: 'x', thumbPath: null,
  sizeBytes: 1, updatedAt: null, updatedBy: 'other@x.c', shareToken: null, ...over,
});

function setup(opts: { signedIn?: boolean; cloud?: boolean; meta?: CloudSyncMeta | null } = {}) {
  const { signedIn = true, cloud = true } = opts;
  const metas = new Map<string, CloudSyncMeta>();
  if (opts.meta !== null) metas.set('p1', opts.meta ?? { knownRev: 3, pendingBaseRev: null });
  const hooks: { beforeWrite?: () => Promise<void> } = {};
  let emit: (m: CloudProjectMeta | null) => void = () => {};
  const unsub = vi.fn();
  const fakeCloud = {
    watchProject: vi.fn((_id: string, cb: (m: CloudProjectMeta | null) => void) => { emit = cb; return unsub; }),
    pushRevision: vi.fn(async (_i: string, b: number) => b + 1),
    pruneRevs: vi.fn(async () => {}),
  };
  const local = { save: vi.fn(async () => {}) } as unknown as LocalDataStore;
  const store = createSyncStore({
    local, cloud: cloud ? (fakeCloud as unknown as CloudStore) : null,
    user: () => (signedIn ? { uid: 'u', email: 'me@x.c' } : null),
    meta: {
      read: async id => metas.get(id) ?? null,
      write: async (id, m) => { await hooks.beforeWrite?.(); metas.set(id, { ...m }); },
      remove: async id => { metas.delete(id); },
    },
    readLocal: async () => raw,
  });
  return { store, hooks, cloud: fakeCloud, unsub, emit: (m: CloudProjectMeta | null) => emit(m), metas };
}
const tick = () => vi.advanceTimersByTimeAsync(0);

describe('syncStore.watch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('delivers a newer revision written by someone else and caches cloud meta', async () => {
    const s = setup(); const cb = vi.fn();
    s.store.watch('p1', cb); await tick();
    s.emit(cmeta({ rev: 4 })); await tick();
    expect(cb).toHaveBeenCalledWith({ rev: 4, updatedBy: 'other@x.c' });
    expect(get(s.store.cloudMeta).p1.updatedBy).toBe('other@x.c');
  });

  it('ignores older, equal and own revisions', async () => {
    const s = setup(); const cb = vi.fn();
    s.store.watch('p1', cb); await tick();
    s.emit(cmeta({ rev: 2 })); s.emit(cmeta({ rev: 3 })); s.emit(null);
    await tick();
    expect(cb).not.toHaveBeenCalled();
  });

  it('delivers the same user pushing from another device, but ignores this instance\'s own push (even before the meta write)', async () => {
    const s = setup(); const cb = vi.fn();
    s.store.watch('p1', cb); await tick();
    s.emit(cmeta({ rev: 4, updatedBy: 'me@x.c' })); await tick();
    expect(cb).toHaveBeenCalledWith({ rev: 4, updatedBy: 'me@x.c' });
    cb.mockClear();

    const o = setup(); const ocb = vi.fn();
    o.store.watch('p1', ocb); await tick();
    // Snapshot of our own revision arrives after pushRevision resolved but before the meta write lands.
    let raced = false;
    o.hooks.beforeWrite = async () => {
      if (raced || o.metas.get('p1')?.pendingBaseRev === null) return;
      raced = true;
      o.emit(cmeta({ rev: 4, updatedBy: 'me@x.c' }));
      await tick();
    };
    await o.store.save({ ...createDefaultProject('A'), id: 'p1' } as Project);
    await vi.advanceTimersByTimeAsync(6_000);
    await tick(); await tick();
    expect(o.cloud.pushRevision).toHaveBeenCalledTimes(1);
    expect(o.metas.get('p1')?.knownRev).toBe(4);
    o.emit(cmeta({ rev: 4, updatedBy: 'me@x.c' })); await tick();
    expect(ocb).not.toHaveBeenCalled();
    o.emit(cmeta({ rev: 5, updatedBy: 'me@x.c' })); await tick();
    expect(ocb).toHaveBeenCalledTimes(1);
  });

  it('ignores a snapshot of its own revision that arrives while pushRevision is still pending', async () => {
    const s = setup(); const cb = vi.fn();
    s.store.watch('p1', cb); await tick();
    let finish: (rev: number) => void = () => {};
    s.cloud.pushRevision.mockImplementation(() => new Promise<number>(r => { finish = r; }));
    await s.store.save({ ...createDefaultProject('A'), id: 'p1' } as Project);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(s.cloud.pushRevision).toHaveBeenCalledTimes(1);
    s.emit(cmeta({ rev: 4, updatedBy: 'me@x.c' })); await tick();
    expect(cb).not.toHaveBeenCalled();
    finish(4); await tick(); await tick();
    expect(cb).not.toHaveBeenCalled();
    expect(s.metas.get('p1')?.knownRev).toBe(4);
  });

  it('is a no-op when untracked, signed out or cloud disabled', async () => {
    for (const o of [{ meta: null }, { signedIn: false }, { cloud: false }, { meta: { knownRev: null, pendingBaseRev: null } }]) {
      const s = setup(o);
      const un = s.store.watch('p1', vi.fn()); await tick();
      expect(s.cloud.watchProject).not.toHaveBeenCalled();
      expect(() => un()).not.toThrow();
    }
  });

  it('unsubscribes, including before setup finished', async () => {
    const s = setup();
    const un = s.store.watch('p1', vi.fn()); await tick();
    un();
    expect(s.unsub).toHaveBeenCalledTimes(1);
    const early = setup();
    early.store.watch('p1', vi.fn())(); await tick();
    expect(early.cloud.watchProject).not.toHaveBeenCalled();
  });
});

describe('syncStore.markConflict', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('sets conflict status and stops auto-push, including for later saves', async () => {
    const s = setup();
    await s.store.save({ ...createDefaultProject('A'), id: 'p1' } as Project);
    expect(get(s.store.syncStatus).p1).toBe('syncing');
    s.store.markConflict('p1');
    expect(get(s.store.syncStatus).p1).toBe('conflict');
    await s.store.save({ ...createDefaultProject('B'), id: 'p1' } as Project);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.cloud.pushRevision).not.toHaveBeenCalled();
    expect(get(s.store.syncStatus).p1).toBe('conflict');
  });
});

describe('cloudSync orchestration', () => {
  it('routes remote changes to a notice or a conflict, and resolves via loadLatest / keepMineAsCopy', async () => {
    vi.resetModules();
    const status = writable<Record<string, string>>({ p1: 'synced' });
    const fake = {
      syncStatus: status,
      markConflict: vi.fn((id: string) => status.update(s => ({ ...s, [id]: 'conflict' }))),
      loadLatest: vi.fn(),
      keepMineAsCopy: vi.fn(),
      load: vi.fn(),
      save: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      saveThumbnail: vi.fn(),
      assertCurrent: vi.fn(),
      watch: vi.fn(() => () => {}),
    };
    vi.doMock('$lib/services/projectStore', () => ({ projectStore: fake }));
    vi.doMock('$lib/stores/auth', () => ({ authState: writable({ status: 'signedOut' }) }));
    vi.doMock('$lib/stores/versionHistory', () => ({ saveSnapshot: vi.fn() }));
    const proj = await import('$lib/stores/project');
    const ss = await import('$lib/stores/saveStatus');
    const cs = await import('$lib/stores/cloudSync');
    const p = { ...proj.createDefaultProject('Mine'), id: 'p1' } as Project;
    proj.loadProject(p); ss.markClean();

    cs.handleRemoteChange('p1', { updatedBy: 'o@x.c' });
    expect(get(cs.remoteChange)).toEqual({ id: 'p1', updatedBy: 'o@x.c' });
    expect(fake.markConflict).not.toHaveBeenCalled();

    const latest = { ...proj.createDefaultProject('Latest'), id: 'p1' } as Project;
    fake.loadLatest.mockResolvedValue(latest);
    ss.saveState.set('saved');
    expect(await cs.reloadLatest()).toBe(true);
    expect(get(proj.currentProject)?.name).toBe('Latest');
    expect(get(cs.remoteChange)).toBeNull();
    expect(get(ss.saveState)).toBe('saved');

    ss.saveState.set('unsaved');
    cs.handleRemoteChange('p1', { updatedBy: 'o@x.c' });
    expect(fake.markConflict).toHaveBeenCalledWith('p1');
    expect(get(cs.remoteChange)).toBeNull();
    ss.saveState.set('saved');

    // pending push also conflicts
    status.set({ p1: 'syncing' });
    cs.handleRemoteChange('p1', { updatedBy: 'o@x.c' });
    expect(fake.markConflict).toHaveBeenCalledTimes(2);

    // keep mine
    fake.keepMineAsCopy.mockResolvedValue({ ...latest, id: 'c', name: 'Mine (My version)' });
    fake.load.mockResolvedValue({ ...latest, name: 'Original' });
    expect(await cs.keepMineAsCopy()).toBe(true);
    expect(get(proj.currentProject)?.name).toBe('Original');
    expect(get(cs.keptCopyName)).toBe('Mine (My version)');

    // errors surface inline
    fake.loadLatest.mockRejectedValue(new Error('boom'));
    expect(await cs.reloadLatest()).toBe(false);
    expect(get(cs.syncError)).toBeTruthy();
    expect(get(cs.syncBusy)).toBe(false);
  });
});
