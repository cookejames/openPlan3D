import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const mocks = vi.hoisted(() => ({ storage: { fake: true } as unknown, read: vi.fn() }));
vi.mock('$lib/firebase', () => ({ get storage() { return mocks.storage; } }));
vi.mock('$lib/services/cloudStore', async () => {
  class ShareNotFoundError extends Error {}
  return { ShareNotFoundError, readSharedSnapshot: (...a: unknown[]) => mocks.read(...a) };
});
const store = vi.hoisted(() => ({
  save: vi.fn(async () => {}), saveThumbnail: vi.fn(), saveCopy: vi.fn(), assertCurrent: vi.fn(async () => {}),
  flush: vi.fn(async () => {}), has: vi.fn(async () => false),
}));
vi.mock('$lib/services/projectStore', () => ({ projectStore: store }));

import { currentProject, createDefaultProject, loadProject, addWall, selectedTool, setActiveFloor, addFloor } from '$lib/stores/project';
import { readOnly } from '$lib/stores/readOnly';
import { markDirty, autoSave, manualSave, markClean, saveState } from '$lib/stores/saveStatus';
import { prepareToLeave } from '$lib/services/deployment';
import { saveSnapshot } from '$lib/stores/versionHistory';
import { openSharedProject } from '$lib/services/projectOpening';
import { ShareNotFoundError } from '$lib/services/cloudStore';

const sharedJson = () => JSON.stringify({ ...createDefaultProject('Shared plan'), id: 'shared-1' });

beforeEach(() => { vi.clearAllMocks(); mocks.storage = { fake: true }; readOnly.set(false); loadProject(createDefaultProject('Mine')); markClean(); });
afterEach(() => { readOnly.set(false); vi.useRealTimers(); });

describe('read-only persistence guard', () => {
  it('markDirty, autoSave, manualSave and prepareToLeave never persist', async () => {
    vi.useFakeTimers();
    readOnly.set(true);
    markDirty();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await autoSave()).toBe(true);
    expect(await manualSave()).toBe(true);
    expect(await prepareToLeave()).toBe(true);
    expect(store.save).not.toHaveBeenCalled();
    expect(store.saveThumbnail).not.toHaveBeenCalled();
    expect(store.flush).not.toHaveBeenCalled();
    expect(get(saveState)).toBe('saved');
  });

  it('writes do persist again once read-only is off', async () => {
    markDirty();
    await autoSave();
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('refuses version snapshots', async () => {
    readOnly.set(true);
    expect(await saveSnapshot(get(currentProject)!, 'x')).toBe(false);
  });

  it('refuses edits and tools but allows floor switching', () => {
    const project = createDefaultProject('Shared');
    loadProject(project);
    readOnly.set(true);
    const before = JSON.stringify(get(currentProject));
    addWall({ x: 0, y: 0 }, { x: 100, y: 0 });
    addFloor('Extra');
    expect(JSON.stringify(get(currentProject))).toBe(before);
    selectedTool.set('wall');
    expect(get(selectedTool)).toBe('select');
    readOnly.set(false);
    addFloor('Second');
    readOnly.set(true);
    const other = get(currentProject)!.floors[1].id;
    setActiveFloor(other);
    expect(get(currentProject)!.activeFloorId).toBe(other);
  });
});

describe('openSharedProject', () => {
  it('opens a valid snapshot read-only without saving', async () => {
    mocks.read.mockResolvedValue(sharedJson());
    const r = await openSharedProject('a'.repeat(32));
    expect(r.status).toBe('ok');
    expect(get(readOnly)).toBe(true);
    expect(get(currentProject)?.name).toBe('Shared plan');
    expect(store.save).not.toHaveBeenCalled();
    expect(get(saveState)).toBe('saved');
  });
  it('reports a missing or revoked link', async () => {
    mocks.read.mockRejectedValue(new ShareNotFoundError());
    expect((await openSharedProject('a'.repeat(32))).status).toBe('notFound');
    expect(get(readOnly)).toBe(false);
  });
  it('reports unavailable sharing when storage is missing', async () => {
    mocks.storage = null;
    expect((await openSharedProject('a'.repeat(32))).status).toBe('unavailable');
  });
  it('reports network and invalid-content failures as errors', async () => {
    mocks.read.mockRejectedValue(new Error('offline'));
    expect((await openSharedProject('a'.repeat(32))).status).toBe('error');
    mocks.read.mockResolvedValue('not json');
    expect((await openSharedProject('a'.repeat(32))).status).toBe('error');
    expect(get(readOnly)).toBe(false);
  });
});
