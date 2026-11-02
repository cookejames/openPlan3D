import { mockStorage, putRaw, rawRecords } from './fixtures/indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalStore, ProjectConflictError } from '$lib/services/datastore';
import { deleteSyncMeta, readSyncMeta, writeSyncMeta } from '$lib/services/localDatabase';
import { createDefaultProject } from '$lib/stores/project';

beforeEach(() => { mockStorage(); });

describe('cloud sync primitives', () => {
  it('adopts newer bytes so a later save of them does not conflict', async () => {
    const store = createLocalStore();
    const project = createDefaultProject('Synced');
    await store.save(project);
    const cloud = { ...project, name: 'Edited elsewhere' };
    await store.adopt(project.id, JSON.stringify(cloud));
    cloud.name = 'Saved here';
    await expect(store.save(cloud)).resolves.toBeUndefined();
    expect((await store.load(project.id))!.name).toBe('Saved here');
  });

  it('still conflicts when IndexedDB changes outside adopt', async () => {
    const store = createLocalStore();
    const project = createDefaultProject('Tracked');
    await store.save(project);
    const other = createLocalStore();
    const elsewhere = { ...project, name: 'Other tab' };
    await other.adopt(project.id, JSON.stringify(elsewhere));
    project.name = 'Stale edit';
    await expect(store.save(project)).rejects.toBeInstanceOf(ProjectConflictError);
    expect((await rawRecords())[project.id]).toBe(JSON.stringify(elsewhere));
  });

  it('round trips sync metadata and returns null when missing', async () => {
    const project = createDefaultProject('Meta');
    expect(await readSyncMeta(project.id)).toBeNull();
    await writeSyncMeta(project.id, { knownRev: 4, pendingBaseRev: null });
    expect(await readSyncMeta(project.id)).toEqual({ knownRev: 4, pendingBaseRev: null });
    await writeSyncMeta(project.id, { knownRev: 5, pendingBaseRev: 4 });
    expect(await readSyncMeta(project.id)).toEqual({ knownRev: 5, pendingBaseRev: 4 });
  });

  it('returns null for unparseable sync metadata', async () => {
    await putRaw('meta', 'cloud-sync:damaged', '{broken');
    expect(await readSyncMeta('damaged')).toBeNull();
  });

  it('removes sync metadata when the project is deleted', async () => {
    const store = createLocalStore();
    const project = createDefaultProject('Deleted');
    await store.save(project);
    await writeSyncMeta(project.id, { knownRev: 1, pendingBaseRev: null });
    await store.delete(project.id);
    expect(await readSyncMeta(project.id)).toBeNull();
  });

  it('round trips the owning account', async () => {
    await writeSyncMeta('owned', { knownRev: 1, pendingBaseRev: null, uid: 'u1' });
    expect(await readSyncMeta('owned')).toEqual({ knownRev: 1, pendingBaseRev: null, uid: 'u1' });
  });

  it('discard removes a project this tab never listed, and the tab that had it open cannot recreate it', async () => {
    const editor = createLocalStore();
    const project = createDefaultProject('Cloud copy');
    await editor.save(project);
    await writeSyncMeta(project.id, { knownRev: 1, pendingBaseRev: null, uid: 'u1' });
    const other = createLocalStore();
    await expect(other.delete(project.id)).rejects.toBeInstanceOf(ProjectConflictError);
    await other.discard(project.id);
    expect((await rawRecords())[project.id]).toBeUndefined();
    expect(await readSyncMeta(project.id)).toBeNull();
    await expect(editor.save({ ...project, name: 'Late save' })).rejects.toBeInstanceOf(ProjectConflictError);
  });

  it('deletes sync metadata directly', async () => {
    await writeSyncMeta('direct', { knownRev: 2, pendingBaseRev: 2 });
    await deleteSyncMeta('direct');
    expect(await readSyncMeta('direct')).toBeNull();
  });
});
