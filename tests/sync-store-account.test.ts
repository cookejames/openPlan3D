import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createSyncStore } from '$lib/services/syncStore';
import type { LocalDataStore } from '$lib/services/datastore';
import type { CloudSyncMeta } from '$lib/services/localDatabase';
import type { CloudStore, CloudProjectMeta } from '$lib/services/cloudStore';
import { createDefaultProject } from '$lib/stores/project';
import type { Project } from '$lib/models/types';

const raw = (id: string, name = id) => JSON.stringify({ ...createDefaultProject(name), id } as Project);
const cmeta = (id: string, over: Partial<CloudProjectMeta> = {}): CloudProjectMeta => ({
  id, name: id, ownerUid: 'u', editorEmails: ['a@b.c'], rev: 3, planPath: 'x', thumbPath: null,
  sizeBytes: 1, updatedAt: new Date('2026-01-02T00:00:00Z'), updatedBy: 'a@b.c', shareToken: null, ...over,
});

/** `user` is mutable so a test can sign in, out or switch account. */
function setup(projects: Record<string, CloudSyncMeta | null>, opts: { authReady?: () => Promise<void> } = {}) {
  const session = { user: { uid: 'u', email: 'a@b.c' } as { uid: string; email: string } | null };
  const disk = new Map<string, string>();
  const metas = new Map<string, CloudSyncMeta>();
  for (const [id, m] of Object.entries(projects)) {
    disk.set(id, raw(id));
    if (m) metas.set(id, m);
  }
  const local = {
    save: vi.fn(async (p: Project) => { disk.set(p.id, JSON.stringify(p)); }),
    load: vi.fn(async (id: string) => (disk.has(id) ? JSON.parse(disk.get(id)!) : null)),
    list: vi.fn(async () => [...disk.entries()].map(([id, r]) => ({ id, name: JSON.parse(r).name, updatedAt: '2026-01-01T00:00:00.000Z' }))),
    discard: vi.fn(async (id: string) => { disk.delete(id); metas.delete(id); }),
  } as unknown as LocalDataStore;
  const fakeCloud = {
    readMeta: vi.fn(async (id: string): Promise<CloudProjectMeta | null> => cmeta(id)),
    listProjects: vi.fn(async (): Promise<CloudProjectMeta[]> => []),
    pushRevision: vi.fn(async (_i: string, b: number) => b + 1),
    pruneRevs: vi.fn(async () => {}),
  };
  const meta = {
    read: vi.fn(async (id: string) => metas.get(id) ?? null),
    write: vi.fn(async (id: string, m: CloudSyncMeta) => { metas.set(id, { ...m }); }),
    remove: vi.fn(async (id: string) => { metas.delete(id); }),
  };
  const store = createSyncStore({
    local, cloud: fakeCloud as unknown as CloudStore,
    user: () => session.user,
    meta, readLocal: async id => disk.get(id) ?? null, authReady: opts.authReady,
  });
  return { store, local, cloud: fakeCloud, metas, disk, session };
}

const ids = async (s: ReturnType<typeof setup>) => (await s.store.list()).map(r => r.id).sort();

describe('sync store: cloud copies belong to one account', () => {
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('signed out: hides cloud copies, clears those with nothing to upload, keeps local-only plans', async () => {
    const s = setup({
      local: null,
      synced: { knownRev: 3, pendingBaseRev: null, uid: 'u' },
      pending: { knownRev: 3, pendingBaseRev: 3, uid: 'u' },
    });
    s.session.user = null;
    expect(await ids(s)).toEqual(['local']);
    expect(s.local.discard).toHaveBeenCalledWith('synced');
    expect(s.local.discard).not.toHaveBeenCalledWith('pending');
    expect(await s.store.load('pending')).toBeNull();
    expect((await s.store.load('local'))?.id).toBe('local');
    expect(s.cloud.listProjects).not.toHaveBeenCalled();
  });

  it('another account cannot see or open the copies, but a project shared with it still lists as a cloud row', async () => {
    const s = setup({ mine: { knownRev: 3, pendingBaseRev: null, uid: 'other' } });
    s.cloud.listProjects.mockResolvedValue([cmeta('mine', { ownerUid: 'other' })]);
    const rows = await s.store.list();
    expect(rows.map(r => r.id)).toEqual(['mine']);
    expect(get(s.store.syncStatus).mine).toBe('cloud');
    expect(s.local.discard).toHaveBeenCalledWith('mine');
    expect(s.local.load).not.toHaveBeenCalled();
  });

  it('a pending copy of another account blocks opening and is never discarded', async () => {
    const s = setup({ theirs: { knownRev: 3, pendingBaseRev: 3, uid: 'other' } });
    expect(await s.store.load('theirs')).toBeNull();
    expect(await ids(s)).toEqual([]);
    expect(s.local.discard).not.toHaveBeenCalled();
    expect(s.cloud.readMeta).not.toHaveBeenCalled();
  });

  it('records from before ownership was kept are adopted by the signed-in account', async () => {
    const s = setup({ old: { knownRev: 3, pendingBaseRev: null } });
    expect(await ids(s)).toEqual(['old']);
    expect(s.metas.get('old')).toEqual({ knownRev: 3, pendingBaseRev: null, uid: 'u' });
  });

  it('records from before ownership was kept are hidden while signed out', async () => {
    const s = setup({ old: { knownRev: 3, pendingBaseRev: null } });
    s.session.user = null;
    expect(await ids(s)).toEqual([]);
  });

  it('waits for auth before deciding what to show', async () => {
    let ready!: () => void;
    const authReady = vi.fn(() => new Promise<void>(r => { ready = r; }));
    const s = setup({ mine: { knownRev: 3, pendingBaseRev: null, uid: 'u' } }, { authReady });
    const listing = s.store.list();
    await Promise.resolve();
    expect(s.local.list).not.toHaveBeenCalled();
    ready();
    expect((await listing).map(r => r.id)).toEqual(['mine']);
    expect(s.local.discard).not.toHaveBeenCalled();
  });

  it('unsyncedProjects pushes waiting edits and reports only the ones still not uploaded', async () => {
    const s = setup({
      ok: { knownRev: 3, pendingBaseRev: null, uid: 'u' },
      bad: { knownRev: 3, pendingBaseRev: null, uid: 'u' },
      local: null,
      theirs: { knownRev: 3, pendingBaseRev: 3, uid: 'other' },
    });
    s.cloud.pushRevision.mockImplementation(async (id: string, b: number) => {
      if (id === 'bad') throw new Error('offline');
      return b + 1;
    });
    await s.store.save(JSON.parse(raw('ok')));
    await s.store.save(JSON.parse(raw('bad')));
    expect(await s.store.unsyncedProjects()).toEqual([{ id: 'bad', name: 'bad' }]);
    expect(s.metas.get('ok')).toMatchObject({ knownRev: 4, pendingBaseRev: null });
    s.store.dispose();
  });

  it('discardCloudCopies removes the account\'s cloud copies, pending or not, and nothing else', async () => {
    const s = setup({
      synced: { knownRev: 3, pendingBaseRev: null, uid: 'u' },
      pending: { knownRev: 3, pendingBaseRev: 3, uid: 'u' },
      old: { knownRev: 1, pendingBaseRev: null },
      local: null,
      theirs: { knownRev: 3, pendingBaseRev: 3, uid: 'other' },
    });
    await s.store.list();
    await s.store.discardCloudCopies('u');
    expect([...s.disk.keys()].sort()).toEqual(['local', 'theirs']);
    expect(get(s.store.syncStatus)).toEqual({});
    expect(get(s.store.cloudMeta)).toEqual({});
  });
});
