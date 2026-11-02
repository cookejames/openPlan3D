import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createSyncStore } from '$lib/services/syncStore';
import type { LocalDataStore } from '$lib/services/datastore';
import type { CloudSyncMeta } from '$lib/services/localDatabase';
import type { CloudProjectMeta, CloudStore } from '$lib/services/cloudStore';
import type { Project } from '$lib/models/types';

const project = (name = 'Plan') => ({ id: 'p1', name }) as unknown as Project;

function setup(opts: { signedIn?: boolean; shareToken?: string | null; tracked?: boolean } = {}) {
  const { signedIn = true, shareToken = 'a'.repeat(32), tracked = true } = opts;
  const disk = new Map<string, string>();
  const metas = new Map<string, CloudSyncMeta>();
  if (tracked) metas.set('p1', { knownRev: 3, pendingBaseRev: null });
  const local = {
    save: vi.fn(async (p: Project) => { disk.set(p.id, JSON.stringify(p)); }),
    load: vi.fn(async (id: string) => (disk.has(id) ? JSON.parse(disk.get(id)!) : null)),
  } as unknown as LocalDataStore;
  const cloudMeta = { id: 'p1', name: 'Plan', ownerUid: 'u', editorEmails: ['a@b.c'], rev: 3, shareToken, updatedBy: 'a@b.c' } as CloudProjectMeta;
  const fakeCloud = {
    pushRevision: vi.fn(async (_id: string, base: number) => base + 1),
    pruneRevs: vi.fn(async () => {}),
    readMeta: vi.fn(async () => cloudMeta),
    updateShareSnapshot: vi.fn(async () => {}),
    enableSharing: vi.fn(async () => 'b'.repeat(32)),
    disableSharing: vi.fn(async () => {}),
    setEditors: vi.fn(async (_id: string, emails: string[]) => ['a@b.c', ...emails]),
  };
  const store = createSyncStore({
    local,
    cloud: fakeCloud as unknown as CloudStore,
    user: () => (signedIn ? { uid: 'u', email: 'a@b.c' } : null),
    meta: {
      read: async id => metas.get(id) ?? null,
      write: async (id, m) => { metas.set(id, { ...m }); },
      remove: async id => { metas.delete(id); },
    },
    readLocal: async id => disk.get(id) ?? null,
  });
  return { store, cloud: fakeCloud, disk };
}

describe('sync store sharing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a push updates the share snapshot when the cached meta has a token', async () => {
    const s = setup();
    await s.store.loadLatest('p1').catch(() => {}); // seeds cloudMeta via readMeta
    await s.store.save(project('Edited'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.cloud.updateShareSnapshot).toHaveBeenCalledWith('a'.repeat(32), JSON.stringify(project('Edited')));
    s.store.dispose();
  });

  it('a snapshot failure warns but leaves status synced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = setup();
    s.cloud.updateShareSnapshot.mockRejectedValue(new Error('nope'));
    await s.store.loadLatest('p1').catch(() => {}); // seeds cloudMeta via readMeta
    await s.store.save(project('Edited'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.cloud.updateShareSnapshot).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(get(s.store.syncStatus).p1).toBe('synced');
    s.store.dispose();
  });

  it('enableSharing flushes a pending push first and records the token', async () => {
    const s = setup({ shareToken: null });
    await s.store.save(project('Edited'));
    const order: string[] = [];
    s.cloud.pushRevision.mockImplementation(async (_i: string, b: number) => { order.push('push'); return b + 1; });
    s.cloud.enableSharing.mockImplementation(async () => { order.push('enable'); return 'b'.repeat(32); });
    const token = await s.store.enableSharing('p1');
    expect(order).toEqual(['push', 'enable']);
    expect(s.cloud.enableSharing).toHaveBeenCalledWith('p1', JSON.stringify(project('Edited')));
    expect(get(s.store.cloudMeta).p1.shareToken).toBe(token);
    await s.store.disableSharing('p1');
    expect(get(s.store.cloudMeta).p1.shareToken).toBeNull();
    const editors = await s.store.setEditors('p1', ['x@y.z']);
    expect(get(s.store.cloudMeta).p1.editorEmails).toEqual(editors);
    s.store.dispose();
  });

  it('methods throw when signed out or untracked', async () => {
    const out = setup({ signedIn: false });
    await expect(out.store.enableSharing('p1')).rejects.toThrow();
    await expect(out.store.disableSharing('p1')).rejects.toThrow();
    await expect(out.store.setEditors('p1', [])).rejects.toThrow();
    const untracked = setup({ tracked: false });
    await expect(untracked.store.enableSharing('p1')).rejects.toThrow();
    expect(untracked.cloud.enableSharing).not.toHaveBeenCalled();
    out.store.dispose(); untracked.store.dispose();
  });
});
