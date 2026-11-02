import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createSyncStore, type SyncStatus } from '$lib/services/syncStore';
import { ProjectConflictError, type LocalDataStore } from '$lib/services/datastore';
import type { CloudSyncMeta } from '$lib/services/localDatabase';
import type { CloudStore } from '$lib/services/cloudStore';
import type { Project } from '$lib/models/types';

const project = (id = 'p1', name = 'Plan') => ({ id, name }) as unknown as Project;

function setup(opts: { signedIn?: boolean; tracked?: boolean; cloud?: boolean } = {}) {
  const { signedIn = true, tracked = true, cloud = true } = opts;
  const disk = new Map<string, string>();
  const metas = new Map<string, CloudSyncMeta>();
  if (tracked) metas.set('p1', { knownRev: 3, pendingBaseRev: null });
  const local = {
    save: vi.fn(async (p: Project) => { disk.set(p.id, JSON.stringify(p)); }),
    load: vi.fn(async (id: string) => (disk.has(id) ? JSON.parse(disk.get(id)!) : null)),
  } as unknown as LocalDataStore;
  const fakeCloud = {
    pushRevision: vi.fn(async (_id: string, base: number) => base + 1),
    pruneRevs: vi.fn(async () => {}),
    createProject: vi.fn(async () => ({})),
  };
  const meta = {
    read: vi.fn(async (id: string) => metas.get(id) ?? null),
    write: vi.fn(async (id: string, m: CloudSyncMeta) => { metas.set(id, { ...m }); }),
    remove: vi.fn(async (id: string) => { metas.delete(id); }),
  };
  const store = createSyncStore({
    local,
    cloud: cloud ? (fakeCloud as unknown as CloudStore) : null,
    user: () => (signedIn ? { uid: 'u', email: 'a@b.c' } : null),
    meta,
    readLocal: async id => disk.get(id) ?? null,
  });
  const history: SyncStatus[] = [];
  store.syncStatus.subscribe(s => { if (s.p1 && history.at(-1) !== s.p1) history.push(s.p1); });
  return { store, local, cloud: fakeCloud, meta, metas, disk, history };
}

const status = (s: { store: ReturnType<typeof setup>['store'] }) => get(s.store.syncStatus).p1;

describe('sync store push', () => {
  let window: EventTarget;
  let doc: EventTarget & { visibilityState: string };
  beforeEach(() => {
    vi.useFakeTimers();
    window = new EventTarget();
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('signed out: only local.save runs, no meta reads', async () => {
    const s = setup({ signedIn: false });
    await s.store.save(project());
    expect(s.local.save).toHaveBeenCalledTimes(1);
    expect(s.meta.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.cloud.pushRevision).not.toHaveBeenCalled();
    s.store.dispose();
  });

  it('untracked project is not pushed and stays local', async () => {
    const s = setup({ tracked: false });
    await s.store.save(project());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.cloud.pushRevision).not.toHaveBeenCalled();
    expect(status(s)).toBe('local');
    s.store.dispose();
  });

  it('debounces two saves into one push and updates meta', async () => {
    const s = setup();
    await s.store.save(project());
    await vi.advanceTimersByTimeAsync(3_000);
    await s.store.save(project('p1', 'Renamed'));
    expect(s.metas.get('p1')).toEqual({ knownRev: 3, pendingBaseRev: 3 });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(s.cloud.pushRevision).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.cloud.pushRevision).toHaveBeenCalledTimes(1);
    expect(s.cloud.pushRevision).toHaveBeenCalledWith('p1', 3, JSON.stringify(project('p1', 'Renamed')), 'Renamed');
    expect(s.metas.get('p1')).toEqual({ knownRev: 4, pendingBaseRev: null });
    expect(s.cloud.pruneRevs).toHaveBeenCalledWith('p1', 4, 10);
    expect(s.history).toEqual(['syncing', 'synced']);
    s.store.dispose();
  });

  it('pushes the latest local bytes, not those captured at save time', async () => {
    const s = setup();
    await s.store.save(project('p1', 'Old'));
    s.disk.set('p1', JSON.stringify(project('p1', 'Newer')));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.cloud.pushRevision).toHaveBeenCalledWith('p1', 3, JSON.stringify(project('p1', 'Newer')), 'Newer');
    s.store.dispose();
  });

  it('conflict keeps pending, sets status, and does not retry', async () => {
    const s = setup();
    s.cloud.pushRevision.mockRejectedValue(new ProjectConflictError());
    await s.store.save(project());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(status(s)).toBe('conflict');
    expect(s.metas.get('p1')).toEqual({ knownRev: 3, pendingBaseRev: 3 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(s.cloud.pushRevision).toHaveBeenCalledTimes(1);
    s.store.dispose();
  });

  it('network errors retry on the backoff schedule', async () => {
    const s = setup();
    s.cloud.pushRevision.mockRejectedValue(new Error('net'));
    await s.store.save(project());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.cloud.pushRevision).toHaveBeenCalledTimes(1);
    expect(status(s)).toBe('error');
    for (const [wait, calls] of [[5_000, 2], [15_000, 3], [60_000, 4], [300_000, 5], [300_000, 6]] as const) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(s.cloud.pushRevision).toHaveBeenCalledTimes(calls - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.cloud.pushRevision).toHaveBeenCalledTimes(calls);
    }
    expect(s.metas.get('p1')!.pendingBaseRev).toBe(3);
    s.cloud.pushRevision.mockImplementation(async (_i: string, b: number) => b + 1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(status(s)).toBe('synced');
    s.store.dispose();
  });

  it('reports offline and retries immediately on the online event', async () => {
    const s = setup();
    vi.stubGlobal('navigator', { onLine: false });
    s.cloud.pushRevision.mockRejectedValueOnce(new Error('net'));
    await s.store.save(project());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(status(s)).toBe('offline');
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.cloud.pushRevision).toHaveBeenCalledTimes(2);
    expect(status(s)).toBe('synced');
    s.store.dispose();
  });

  it('a save during an in-flight push causes exactly one follow-up with the new base rev', async () => {
    const s = setup();
    let release!: () => void;
    s.cloud.pushRevision.mockImplementationOnce(async (_i: string, b: number) => {
      await new Promise<void>(r => { release = r; });
      return b + 1;
    });
    await s.store.save(project());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.cloud.pushRevision).toHaveBeenCalledTimes(1);
    await s.store.save(project('p1', 'Edited'));
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.metas.get('p1')).toEqual({ knownRev: 4, pendingBaseRev: 4 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.cloud.pushRevision).toHaveBeenCalledTimes(2);
    expect(s.cloud.pushRevision).toHaveBeenLastCalledWith('p1', 4, JSON.stringify(project('p1', 'Edited')), 'Edited');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.cloud.pushRevision).toHaveBeenCalledTimes(2);
    expect(s.metas.get('p1')).toEqual({ knownRev: 5, pendingBaseRev: null });
    s.store.dispose();
  });

  it('pushes immediately when the page becomes hidden', async () => {
    const s = setup();
    await s.store.save(project());
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.cloud.pushRevision).toHaveBeenCalledTimes(1);
    s.store.dispose();
  });

  it('flush(id) pushes now', async () => {
    const s = setup();
    await s.store.save(project());
    await s.store.flush('p1');
    expect(s.cloud.pushRevision).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.cloud.pushRevision).toHaveBeenCalledTimes(1);
    s.store.dispose();
  });

  it('uploadToCloud creates the project and records rev 0', async () => {
    const s = setup({ tracked: false });
    await s.local.save(project());
    await s.store.uploadToCloud('p1');
    expect(s.cloud.createProject).toHaveBeenCalledWith(project());
    expect(s.metas.get('p1')).toEqual({ knownRev: 0, pendingBaseRev: null });
    s.store.dispose();
  });

  it('uploadToCloud throws when signed out', async () => {
    const s = setup({ signedIn: false, tracked: false });
    await expect(s.store.uploadToCloud('p1')).rejects.toThrow();
    expect(s.cloud.createProject).not.toHaveBeenCalled();
    s.store.dispose();
  });
});
