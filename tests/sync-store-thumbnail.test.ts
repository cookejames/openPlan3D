import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createSyncStore, type SyncStatus } from '$lib/services/syncStore';
import type { LocalDataStore } from '$lib/services/datastore';
import type { CloudSyncMeta } from '$lib/services/localDatabase';
import type { CloudStore } from '$lib/services/cloudStore';
import type { Project } from '$lib/models/types';

const project = (id = 'p1', name = 'Plan') => ({ id, name }) as unknown as Project;
// The first four bytes of a JPEG (FF D8 FF E0) in base64.
const JPEG_HEAD_B64 = '/9j/4A==';
const dataUrl = (b64: string) => `data:image/jpeg;base64,${b64}`;

function setup(opts: { signedIn?: boolean; tracked?: boolean; cloud?: boolean } = {}) {
  const { signedIn = true, tracked = true, cloud = true } = opts;
  const disk = new Map<string, string>();
  const metas = new Map<string, CloudSyncMeta>();
  if (tracked) metas.set('p1', { knownRev: 3, pendingBaseRev: null });
  const local = {
    save: vi.fn(async (p: Project) => { disk.set(p.id, JSON.stringify(p)); }),
    load: vi.fn(async (id: string) => (disk.has(id) ? JSON.parse(disk.get(id)!) : null)),
    saveThumbnail: vi.fn(async () => {}),
  } as unknown as LocalDataStore;
  const fakeCloud = {
    pushRevision: vi.fn(async (_id: string, base: number) => base + 1),
    pruneRevs: vi.fn(async () => {}),
    createProject: vi.fn(async () => ({})),
    uploadThumbnail: vi.fn(async (_id: string, _blob: Blob) => {}),
    readMeta: vi.fn(async () => null),
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

describe('sync store thumbnails', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('signed out: only local.saveThumbnail runs, no meta reads or uploads', async () => {
    const s = setup({ signedIn: false });
    await s.store.saveThumbnail('p1', dataUrl(JPEG_HEAD_B64));
    expect(s.local.saveThumbnail).toHaveBeenCalledWith('p1', dataUrl(JPEG_HEAD_B64));
    expect(s.meta.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.cloud.uploadThumbnail).not.toHaveBeenCalled();
    s.store.dispose();
  });

  it('cloud disabled: only local.saveThumbnail runs', async () => {
    const s = setup({ cloud: false });
    await s.store.saveThumbnail('p1', dataUrl(JPEG_HEAD_B64));
    expect(s.local.saveThumbnail).toHaveBeenCalledTimes(1);
    expect(s.meta.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.cloud.uploadThumbnail).not.toHaveBeenCalled();
    s.store.dispose();
  });

  it('untracked project: only local.saveThumbnail runs, no upload', async () => {
    const s = setup({ tracked: false });
    await s.store.saveThumbnail('p1', dataUrl(JPEG_HEAD_B64));
    expect(s.local.saveThumbnail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.cloud.uploadThumbnail).not.toHaveBeenCalled();
    expect(status(s)).toBeUndefined();
    s.store.dispose();
  });

  it('tracked: one upload after 5 s, carrying the latest of several calls', async () => {
    const s = setup();
    await s.store.saveThumbnail('p1', dataUrl('AAAA'));
    await vi.advanceTimersByTimeAsync(3_000);
    await s.store.saveThumbnail('p1', dataUrl('AAAA'));
    await vi.advanceTimersByTimeAsync(1_000);
    await s.store.saveThumbnail('p1', dataUrl(JPEG_HEAD_B64));
    expect(s.local.saveThumbnail).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(s.cloud.uploadThumbnail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.cloud.uploadThumbnail).toHaveBeenCalledTimes(1);
    expect(s.cloud.uploadThumbnail.mock.calls[0][0]).toBe('p1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.cloud.uploadThumbnail).toHaveBeenCalledTimes(1);
    s.store.dispose();
  });

  it('decodes the base64 JPEG data URL into the uploaded blob', async () => {
    const s = setup();
    await s.store.saveThumbnail('p1', dataUrl(JPEG_HEAD_B64));
    await vi.advanceTimersByTimeAsync(5_000);
    const blob = s.cloud.uploadThumbnail.mock.calls[0][1] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(4);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    s.store.dispose();
  });

  it('skips thumbnails over 200 KB and uploads exactly 200 KB', async () => {
    const s = setup();
    const over = Buffer.alloc(200 * 1024 + 1, 1).toString('base64');
    const exact = Buffer.alloc(200 * 1024, 1).toString('base64');
    await s.store.saveThumbnail('p1', dataUrl(over));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.cloud.uploadThumbnail).not.toHaveBeenCalled();
    await s.store.saveThumbnail('p1', dataUrl(exact));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.cloud.uploadThumbnail).toHaveBeenCalledTimes(1);
    expect((s.cloud.uploadThumbnail.mock.calls[0][1] as Blob).size).toBe(200 * 1024);
    s.store.dispose();
  });

  it('upload error is swallowed: no retry and no status change', async () => {
    const s = setup();
    s.cloud.uploadThumbnail.mockRejectedValue(new Error('storage down'));
    await s.store.saveThumbnail('p1', dataUrl(JPEG_HEAD_B64));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.cloud.uploadThumbnail).toHaveBeenCalledTimes(1);
    expect(status(s)).toBeUndefined();
    expect(s.history).toEqual([]);
    expect(s.metas.get('p1')).toEqual({ knownRev: 3, pendingBaseRev: null });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(s.cloud.uploadThumbnail).toHaveBeenCalledTimes(1);
    expect(s.cloud.pushRevision).not.toHaveBeenCalled();
    s.store.dispose();
  });

  it('thumbnail uploads do not change plan push status', async () => {
    const s = setup();
    await s.store.save(project());
    await s.store.saveThumbnail('p1', dataUrl(JPEG_HEAD_B64));
    expect(status(s)).toBe('syncing');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.cloud.pushRevision).toHaveBeenCalledTimes(1);
    expect(status(s)).toBe('synced');
    s.store.dispose();
  });

  it('dispose cancels a pending thumbnail upload', async () => {
    const s = setup();
    await s.store.saveThumbnail('p1', dataUrl(JPEG_HEAD_B64));
    s.store.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.cloud.uploadThumbnail).not.toHaveBeenCalled();
  });

  it('delete cancels a pending thumbnail upload', async () => {
    const s = setup();
    await s.store.saveThumbnail('p1', dataUrl(JPEG_HEAD_B64));
    await s.store.delete('p1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.cloud.uploadThumbnail).not.toHaveBeenCalled();
    s.store.dispose();
  });
});
