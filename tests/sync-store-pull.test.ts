import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createSyncStore } from '$lib/services/syncStore';
import type { LocalDataStore } from '$lib/services/datastore';
import type { CloudSyncMeta } from '$lib/services/localDatabase';
import type { CloudStore, CloudProjectMeta } from '$lib/services/cloudStore';
import { createDefaultProject } from '$lib/stores/project';
import type { Project } from '$lib/models/types';

const make = (id = 'p1', name = 'Plan') => ({ ...createDefaultProject(name), id }) as Project;
const raw = (id = 'p1', name = 'Plan') => JSON.stringify(make(id, name));
const cmeta = (over: Partial<CloudProjectMeta> = {}): CloudProjectMeta => ({
  id: 'p1', name: 'Cloud', ownerUid: 'u', editorEmails: ['a@b.c'], rev: 5, planPath: 'x', thumbPath: null,
  sizeBytes: 1, updatedAt: new Date('2026-01-02T00:00:00Z'), updatedBy: 'a@b.c', shareToken: null, ...over,
});

function setup(opts: { signedIn?: boolean; cloud?: boolean; meta?: CloudSyncMeta | null; disk?: string | null } = {}) {
  const { signedIn = true, cloud = true } = opts;
  const disk = new Map<string, string>();
  const metas = new Map<string, CloudSyncMeta>();
  if (opts.disk !== null) disk.set('p1', opts.disk ?? raw('p1', 'Local'));
  if (opts.meta !== null) metas.set('p1', opts.meta ?? { knownRev: 3, pendingBaseRev: null });
  const local = {
    save: vi.fn(async (p: Project) => { disk.set(p.id, JSON.stringify(p)); }),
    load: vi.fn(async (id: string) => (disk.has(id) ? JSON.parse(disk.get(id)!) : null)),
    adopt: vi.fn(async (id: string, r: string) => { disk.set(id, r); }),
    list: vi.fn(async () => [...disk.entries()].map(([id, r]) => ({ id, name: JSON.parse(r).name, updatedAt: '2026-01-01T00:00:00.000Z' }))),
    delete: vi.fn(async (id: string) => { disk.delete(id); }),
    saveCopy: vi.fn(async (p: Project, suffix?: string) => {
      const c = { ...p, id: 'copy', name: `${p.name} (${suffix})` } as Project;
      disk.set('copy', JSON.stringify(c));
      return c;
    }),
    duplicate: vi.fn(async () => null),
  } as unknown as LocalDataStore;
  const fakeCloud = {
    readMeta: vi.fn(async (): Promise<CloudProjectMeta | null> => cmeta()),
    downloadLatest: vi.fn(async () => raw('p1', 'Cloud')),
    listProjects: vi.fn(async (): Promise<CloudProjectMeta[]> => []),
    deleteProject: vi.fn(async () => {}),
    pushRevision: vi.fn(async (_i: string, b: number) => b + 1),
    pruneRevs: vi.fn(async () => {}),
  };
  const meta = {
    read: vi.fn(async (id: string) => metas.get(id) ?? null),
    write: vi.fn(async (id: string, m: CloudSyncMeta) => { metas.set(id, { ...m }); }),
    remove: vi.fn(async (id: string) => { metas.delete(id); }),
  };
  const store = createSyncStore({
    local, cloud: cloud ? (fakeCloud as unknown as CloudStore) : null,
    user: () => (signedIn ? { uid: 'u', email: 'a@b.c' } : null),
    meta, readLocal: async id => disk.get(id) ?? null, cloudTimeoutMs: 8_000,
  });
  return { store, local, cloud: fakeCloud, meta, metas, disk };
}
const st = (s: ReturnType<typeof setup>, id = 'p1') => get(s.store.syncStatus)[id];

describe('sync store pull', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => { vi.useRealTimers(); });

  describe('open', () => {
    it('both absent returns null', async () => {
      const s = setup({ disk: null, meta: null });
      s.cloud.readMeta.mockResolvedValue(null);
      expect(await s.store.load('p1')).toBeNull();
      s.store.dispose();
    });

    it('cloud-only project is downloaded, adopted and tracked', async () => {
      const s = setup({ disk: null, meta: null });
      const p = await s.store.load('p1');
      expect(p?.name).toBe('Cloud');
      expect(s.local.adopt).toHaveBeenCalledWith('p1', await s.cloud.downloadLatest.mock.results[0].value);
      expect(s.metas.get('p1')).toEqual({ knownRev: 5, pendingBaseRev: null });
      expect(st(s)).toBe('synced');
      expect(get(s.store.cloudMeta).p1).toEqual({ ownerUid: 'u', isOwner: true, updatedBy: 'a@b.c' });
      s.store.dispose();
    });

    it('older knownRev with no pending pulls the newer cloud copy', async () => {
      const s = setup();
      expect((await s.store.load('p1'))?.name).toBe('Cloud');
      expect(s.metas.get('p1')).toEqual({ knownRev: 5, pendingBaseRev: null });
      expect(st(s)).toBe('synced');
      s.store.dispose();
    });

    it('rejects a download whose id does not match', async () => {
      const s = setup();
      s.cloud.downloadLatest.mockResolvedValue(raw('other'));
      expect((await s.store.load('p1'))?.name).toBe('Local');
      expect(s.local.adopt).not.toHaveBeenCalled();
      expect(st(s)).toBe('error');
      s.store.dispose();
    });

    it('newer cloud with pending local edits is a conflict and never auto-pushes', async () => {
      const s = setup({ meta: { knownRev: 3, pendingBaseRev: 3 } });
      expect((await s.store.load('p1'))?.name).toBe('Local');
      expect(st(s)).toBe('conflict');
      expect(s.local.adopt).not.toHaveBeenCalled();
      await s.store.save(make('p1', 'Edit'));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(s.cloud.pushRevision).not.toHaveBeenCalled();
      expect(st(s)).toBe('conflict');
      s.store.dispose();
    });

    it('equal rev without pending is synced', async () => {
      const s = setup({ meta: { knownRev: 5, pendingBaseRev: null } });
      expect((await s.store.load('p1'))?.name).toBe('Local');
      expect(st(s)).toBe('synced');
      expect(s.cloud.downloadLatest).not.toHaveBeenCalled();
      s.store.dispose();
    });

    it('equal rev with pending is syncing and schedules a push', async () => {
      const s = setup({ meta: { knownRev: 5, pendingBaseRev: 5 } });
      await s.store.load('p1');
      expect(st(s)).toBe('syncing');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(s.cloud.pushRevision).toHaveBeenCalledTimes(1);
      expect(st(s)).toBe('synced');
      s.store.dispose();
    });

    it('cloud meta gone for a tracked project keeps local and untracks it', async () => {
      const s = setup();
      s.cloud.readMeta.mockResolvedValue(null);
      expect((await s.store.load('p1'))?.name).toBe('Local');
      expect(s.metas.has('p1')).toBe(false);
      expect(st(s)).toBe('local');
      expect(s.local.delete).not.toHaveBeenCalled();
      s.store.dispose();
    });

    it('network error falls back to local: error, or offline when offline', async () => {
      const s = setup();
      s.cloud.readMeta.mockRejectedValue(new Error('net'));
      expect((await s.store.load('p1'))?.name).toBe('Local');
      expect(st(s)).toBe('error');
      vi.stubGlobal('navigator', { onLine: false });
      await s.store.load('p1');
      expect(st(s)).toBe('offline');
      s.store.dispose();
    });

    it('download failure falls back to local', async () => {
      const s = setup();
      s.cloud.downloadLatest.mockRejectedValue(new Error('net'));
      expect((await s.store.load('p1'))?.name).toBe('Local');
      expect(st(s)).toBe('error');
      s.store.dispose();
    });

    it('a hung cloud times out and opens local, and a late download is not adopted', async () => {
      const s = setup();
      let release!: () => void;
      s.cloud.readMeta.mockImplementation(() => new Promise<CloudProjectMeta | null>(r => { release = () => r(cmeta()); }));
      const pending = s.store.load('p1');
      await vi.advanceTimersByTimeAsync(8_000);
      expect((await pending)?.name).toBe('Local');
      expect(st(s)).toBe('error');
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.local.adopt).not.toHaveBeenCalled();
      s.store.dispose();
    });
  });

  describe('list', () => {
    it('merges, dedupes, and sets statuses including cloud', async () => {
      const s = setup();
      s.disk.set('p2', raw('p2', 'Plain'));
      s.cloud.listProjects.mockResolvedValue([cmeta(), cmeta({ id: 'p3', name: 'Shared', ownerUid: 'other', updatedAt: new Date('2026-03-01T00:00:00Z') })]);
      const rows = await s.store.list();
      expect(rows.map(r => r.id).sort()).toEqual(['p1', 'p2', 'p3']);
      expect(rows.find(r => r.id === 'p1')!.name).toBe('Local');
      expect(rows.find(r => r.id === 'p3')).toEqual({ id: 'p3', name: 'Shared', updatedAt: '2026-03-01T00:00:00.000Z' });
      expect(st(s)).toBe('synced');
      expect(st(s, 'p2')).toBe('local');
      expect(st(s, 'p3')).toBe('cloud');
      expect(get(s.store.cloudMeta).p3.isOwner).toBe(false);
      s.store.dispose();
    });

    it('keeps conflict status for rows in both', async () => {
      const s = setup({ meta: { knownRev: 3, pendingBaseRev: 3 } });
      await s.store.load('p1');
      s.cloud.listProjects.mockResolvedValue([cmeta()]);
      await s.store.list();
      expect(st(s)).toBe('conflict');
      s.store.dispose();
    });

    it('a failing cloud list returns the local list and leaves statuses alone', async () => {
      const s = setup();
      s.cloud.listProjects.mockRejectedValue(new Error('net'));
      const rows = await s.store.list();
      expect(rows.map(r => r.id)).toEqual(['p1']);
      expect(get(s.store.syncStatus)).toEqual({});
      s.store.dispose();
    });
  });

  describe('delete', () => {
    it('owner deletes cloud first, then local and meta', async () => {
      const s = setup();
      s.cloud.readMeta.mockResolvedValue(cmeta({ rev: 3 }));
      await s.store.delete('p1');
      expect(s.cloud.deleteProject).toHaveBeenCalledWith('p1');
      expect(s.cloud.deleteProject.mock.invocationCallOrder[0]).toBeLessThan((s.local.delete as any).mock.invocationCallOrder[0]);
      expect(s.disk.has('p1')).toBe(false);
      expect(s.metas.has('p1')).toBe(false);
      s.store.dispose();
    });

    it('failing cloud delete throws and keeps local', async () => {
      const s = setup();
      s.cloud.deleteProject.mockRejectedValue(new Error('denied'));
      await expect(s.store.delete('p1')).rejects.toThrow('denied');
      expect(s.local.delete).not.toHaveBeenCalled();
      expect(s.disk.has('p1')).toBe(true);
      expect(s.metas.has('p1')).toBe(true);
      s.store.dispose();
    });

    it('non-owner deletes only the local copy and meta', async () => {
      const s = setup();
      s.cloud.readMeta.mockResolvedValue(cmeta({ ownerUid: 'other' }));
      await s.store.delete('p1');
      expect(s.cloud.deleteProject).not.toHaveBeenCalled();
      expect(s.disk.has('p1')).toBe(false);
      expect(s.metas.has('p1')).toBe(false);
      s.store.dispose();
    });

    it('cloud-only owner project is deleted from the cloud without a local delete', async () => {
      const s = setup({ disk: null, meta: null });
      s.cloud.listProjects.mockResolvedValue([cmeta()]);
      await s.store.list();
      await s.store.delete('p1');
      expect(s.cloud.deleteProject).toHaveBeenCalledWith('p1');
      expect(s.local.delete).not.toHaveBeenCalled();
      s.store.dispose();
    });

    it('untracked project only deletes locally', async () => {
      const s = setup({ meta: null });
      await s.store.delete('p1');
      expect(s.local.delete).toHaveBeenCalledWith('p1');
      expect(s.cloud.readMeta).not.toHaveBeenCalled();
      expect(s.cloud.deleteProject).not.toHaveBeenCalled();
      s.store.dispose();
    });
  });

  describe('conflict resolution', () => {
    it('loadLatest discards local edits and clears the conflict', async () => {
      const s = setup({ meta: { knownRev: 3, pendingBaseRev: 3 } });
      await s.store.load('p1');
      expect(st(s)).toBe('conflict');
      const p = await s.store.loadLatest('p1');
      expect(p.name).toBe('Cloud');
      expect(s.metas.get('p1')).toEqual({ knownRev: 5, pendingBaseRev: null });
      expect(st(s)).toBe('synced');
      await s.store.save(make('p1', 'After'));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(s.cloud.pushRevision).toHaveBeenCalledWith('p1', 5, expect.any(String), 'After');
      s.store.dispose();
    });

    it('keepMineAsCopy saves a local copy then takes the cloud version', async () => {
      const s = setup({ meta: { knownRev: 3, pendingBaseRev: 3 } });
      const copy = await s.store.keepMineAsCopy('p1');
      expect(s.local.saveCopy).toHaveBeenCalledWith(expect.objectContaining({ name: 'Local' }), 'My version');
      expect(copy.id).toBe('copy');
      expect(copy.name).toBe('Local (My version)');
      expect(JSON.parse(s.disk.get('p1')!).name).toBe('Cloud');
      expect(s.metas.get('p1')).toEqual({ knownRev: 5, pendingBaseRev: null });
      expect(s.metas.has('copy')).toBe(false);
      s.store.dispose();
    });
  });

  describe('signed out', () => {
    it('delegates load, list and delete to local with no cloud or meta calls', async () => {
      const s = setup({ signedIn: false });
      expect((await s.store.load('p1'))?.name).toBe('Local');
      expect((await s.store.list()).map(r => r.id)).toEqual(['p1']);
      await s.store.delete('p1');
      expect(s.local.delete).toHaveBeenCalledWith('p1');
      expect(s.meta.read).not.toHaveBeenCalled();
      expect(s.cloud.readMeta).not.toHaveBeenCalled();
      expect(s.cloud.listProjects).not.toHaveBeenCalled();
      expect(s.cloud.deleteProject).not.toHaveBeenCalled();
      s.store.dispose();
    });

    it('null cloud behaves like local', async () => {
      const s = setup({ cloud: false });
      expect((await s.store.load('p1'))?.name).toBe('Local');
      await expect(s.store.loadLatest('p1')).rejects.toThrow();
      s.store.dispose();
    });
  });
});
