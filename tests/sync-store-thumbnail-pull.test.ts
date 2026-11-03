import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createSyncStore } from '$lib/services/syncStore';
import type { LocalDataStore } from '$lib/services/datastore';
import type { CloudProjectMeta, CloudStore } from '$lib/services/cloudStore';
import type { Project } from '$lib/models/types';

const cm = (id: string, thumb: boolean, ms = 1000): CloudProjectMeta => ({
  id, name: id, ownerUid: 'u', editorEmails: [], rev: 1, planPath: 'x', thumbPath: thumb ? `projects/${id}/thumb.jpg` : null,
  sizeBytes: 1, updatedAt: new Date(ms), updatedBy: 'u', shareToken: null,
});

function setup(opts: { signedIn?: boolean; remote?: CloudProjectMeta[]; localThumbs?: Record<string, string>; versions?: Record<string, string> } = {}) {
  const { signedIn = true, remote = [], localThumbs = {}, versions = {} } = opts;
  const thumbs = { ...localThumbs };
  const vers = { ...versions };
  const local = {
    list: vi.fn(async () => []),
    getThumbnails: vi.fn(async () => ({ ...thumbs })),
    getThumbnail: vi.fn(async (id: string) => thumbs[id] ?? null),
    cacheThumbnail: vi.fn(async (id: string, url: string, v: string) => { thumbs[id] = url; vers[id] = v; }),
    getCachedThumbnailVersion: vi.fn(async (id: string) => vers[id] ?? null),
    load: vi.fn(async () => ({ id: 'p1', name: 'P' }) as unknown as Project),
  } as unknown as LocalDataStore;
  let active = 0, peak = 0;
  const cloud = {
    listProjects: vi.fn(async () => remote),
    downloadThumbnail: vi.fn(async (m: CloudProjectMeta) => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return `data:image/jpeg;base64,${m.id}`;
    }),
    createProject: vi.fn(async () => ({})),
    uploadThumbnail: vi.fn(async () => {}),
  };
  const store = createSyncStore({
    local, cloud: signedIn ? (cloud as unknown as CloudStore) : null,
    user: () => (signedIn ? { uid: 'u', email: 'a@b.c' } : null),
    meta: { read: async () => null, write: async () => {}, remove: async () => {} },
    readLocal: async () => null,
  });
  return { store, local, cloud, thumbs, peak: () => peak };
}

const settle = () => new Promise(r => setTimeout(r, 80));

describe('cloud thumbnails in the library', () => {
  it('returns local ones immediately, fetches missing cloud ones, caches them and signals', async () => {
    const remote = [cm('a', true), cm('b', true), cm('c', false), cm('d', true)];
    const s = setup({ remote, localThumbs: { d: 'local-d' } });
    await s.store.list();
    const first = await s.store.getThumbnails();
    expect(first).toEqual({ d: 'local-d' });
    await settle();
    expect(s.local.cacheThumbnail).toHaveBeenCalledTimes(2);
    expect(get(s.store.thumbnailsUpdated)).toBe(1);
    const second = await s.store.getThumbnails();
    expect(second).toEqual({ d: 'local-d', a: 'data:image/jpeg;base64,a', b: 'data:image/jpeg;base64,b' });
    await settle();
    expect(s.cloud.downloadThumbnail).toHaveBeenCalledTimes(2);
  });

  it('limits concurrent downloads to 4', async () => {
    const remote = Array.from({ length: 12 }, (_, i) => cm(`p${i}`, true));
    const s = setup({ remote });
    await s.store.list();
    await s.store.getThumbnails();
    await settle(); await settle();
    expect(s.cloud.downloadThumbnail).toHaveBeenCalledTimes(12);
    expect(s.peak()).toBeLessThanOrEqual(4);
    expect(s.peak()).toBeGreaterThan(1);
  });

  it('refetches a cached cloud thumbnail when the cloud version changed', async () => {
    const s = setup({ remote: [cm('a', true, 2000)], localThumbs: { a: 'old' }, versions: { a: 'projects/a/thumb.jpg@1000' } });
    await s.store.list();
    await s.store.getThumbnails();
    await settle();
    expect(s.thumbs.a).toBe('data:image/jpeg;base64,a');
  });

  it('keeps a local thumbnail that is not a cached cloud one', async () => {
    const s = setup({ remote: [cm('a', true)], localThumbs: { a: 'mine' } });
    await s.store.list();
    await s.store.getThumbnails();
    await settle();
    expect(s.cloud.downloadThumbnail).not.toHaveBeenCalled();
  });

  it('signed out: returns local thumbnails and never touches the cloud', async () => {
    const s = setup({ signedIn: false, remote: [cm('a', true)], localThumbs: { x: 'y' } });
    expect(await s.store.getThumbnails()).toEqual({ x: 'y' });
    await settle();
    expect(s.local.cacheThumbnail).not.toHaveBeenCalled();
  });

  it('uploadToCloud uploads an existing local thumbnail', async () => {
    const s = setup({ localThumbs: { p1: 'data:image/jpeg;base64,/9j/4A==' } });
    await s.store.uploadToCloud('p1');
    expect(s.cloud.uploadThumbnail).toHaveBeenCalledTimes(1);
    expect((s.cloud.uploadThumbnail.mock.calls[0] as unknown[])[0]).toBe('p1');
  });

  it('uploadToCloud succeeds without a thumbnail', async () => {
    const s = setup();
    await s.store.uploadToCloud('p1');
    expect(s.cloud.uploadThumbnail).not.toHaveBeenCalled();
  });
});
