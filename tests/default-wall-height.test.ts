import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { Project } from '$lib/models/types';
import { DEFAULT_WALL_HEIGHT, projectDefaultWallHeight } from '$lib/models/types';
import {
  addWall, createDefaultProject, currentProject, loadProject, redo, splitWall, undo, updateProjectDefaultWallHeight,
} from '$lib/stores/project';
import { readOnly } from '$lib/stores/readOnly';
import { placePreset, roomPresets } from '$lib/utils/roomPresets';
import { readProject } from '$lib/utils/projectValidation';
import { projectPackageBytes, readProjectPackage } from '$lib/services/projectPackage';
import { createLocalStore } from '$lib/services/datastore';
import { mockStorage } from './fixtures/indexeddb';
import { roomProject } from './fixtures/project';

const project = () => get(currentProject)!;
const walls = () => project().floors[0].walls;

beforeEach(() => {
  mockStorage();
  readOnly.set(false);
  loadProject(createDefaultProject('Default wall height'));
});

describe('Project default wall height', () => {
  it('starts new projects at 280 cm', () => {
    expect(DEFAULT_WALL_HEIGHT).toBe(280);
    expect(projectDefaultWallHeight(project())).toBe(280);
    addWall({ x: 0, y: 0 }, { x: 300, y: 0 });
    expect(walls()[0]).toMatchObject({ height: 280, startHeight: 280, endHeight: 280 });
  });

  it('gives new walls the project height and leaves existing walls unchanged', () => {
    const first = addWall({ x: 0, y: 0 }, { x: 300, y: 0 });
    updateProjectDefaultWallHeight(240);
    expect(project().defaultWallHeight).toBe(240);
    const second = addWall({ x: 300, y: 0 }, { x: 300, y: 300 });
    expect(walls().find(w => w.id === first)).toMatchObject({ height: 280, startHeight: 280, endHeight: 280 });
    expect(walls().find(w => w.id === second)).toMatchObject({ height: 240, startHeight: 240, endHeight: 240 });
  });

  it('keeps a separate default for each project', () => {
    updateProjectDefaultWallHeight(250);
    const a = structuredClone(project());
    loadProject(createDefaultProject('Other'));
    expect(project().defaultWallHeight).toBeUndefined();
    addWall({ x: 0, y: 0 }, { x: 300, y: 0 });
    expect(walls()[0].height).toBe(280);
    updateProjectDefaultWallHeight(320);
    const b = structuredClone(project());

    loadProject(a);
    addWall({ x: 0, y: 0 }, { x: 300, y: 0 });
    expect(walls().at(-1)!.height).toBe(250);
    loadProject(b);
    addWall({ x: 0, y: 0 }, { x: 0, y: 300 });
    expect(walls().at(-1)!.height).toBe(320);
  });

  it('applies to room presets drawn as walls', () => {
    updateProjectDefaultWallHeight(310);
    placePreset(roomPresets[0], { x: 0, y: 0 });
    expect(walls().length).toBeGreaterThan(0);
    for (const wall of walls()) expect(wall).toMatchObject({ height: 310, startHeight: 310, endHeight: 310 });
  });

  it('keeps the height of an existing wall that is split', () => {
    const id = addWall({ x: 0, y: 0 }, { x: 400, y: 0 });
    updateProjectDefaultWallHeight(200);
    splitWall(id, 0.5);
    expect(walls()).toHaveLength(2);
    for (const wall of walls()) expect(wall).toMatchObject({ startHeight: 280, endHeight: 280 });
  });

  it('is one Undo step that marks the project modified, and resets to 280', () => {
    const before = project().updatedAt.getTime();
    updateProjectDefaultWallHeight(250);
    expect(project().updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    undo();
    expect(project().defaultWallHeight).toBeUndefined();
    redo();
    expect(project().defaultWallHeight).toBe(250);
    updateProjectDefaultWallHeight();
    expect(project().defaultWallHeight).toBeUndefined();
    addWall({ x: 0, y: 0 }, { x: 300, y: 0 });
    expect(walls()[0].height).toBe(280);
  });

  it('ignores invalid heights and edits while read-only', () => {
    updateProjectDefaultWallHeight(250);
    for (const height of [0, -5, Number.NaN, Infinity]) updateProjectDefaultWallHeight(height);
    expect(project().defaultWallHeight).toBe(250);
    readOnly.set(true);
    updateProjectDefaultWallHeight(300);
    readOnly.set(false);
    expect(project().defaultWallHeight).toBe(250);
  });

  it('removes a new wall with one Undo', () => {
    updateProjectDefaultWallHeight(250);
    addWall({ x: 0, y: 0 }, { x: 300, y: 0 });
    undo();
    expect(walls()).toHaveLength(0);
    expect(project().defaultWallHeight).toBe(250);
  });
});

describe('Project default wall height persistence', () => {
  const withHeight = (defaultWallHeight?: unknown): Project => ({ ...roomProject(), defaultWallHeight } as Project);

  it('accepts valid values and drops unusable ones on load', () => {
    expect(readProject(withHeight()).defaultWallHeight).toBeUndefined();
    expect(readProject(withHeight(262.5)).defaultWallHeight).toBe(262.5);
    for (const value of [0, -10, Number.NaN, Infinity, '280', null]) {
      const loaded = readProject(withHeight(value));
      expect(loaded.defaultWallHeight).toBeUndefined();
      expect(projectDefaultWallHeight(loaded)).toBe(280);
    }
  });

  it('survives JSON export/import', () => {
    const imported = readProject(JSON.parse(JSON.stringify(withHeight(245))));
    expect(imported.defaultWallHeight).toBe(245);
  });

  it('survives save and reload from the local library', async () => {
    const store = createLocalStore();
    const a = withHeight(245), b = { ...withHeight(310), id: 'second-project' };
    await store.save(a); await store.save(b);
    expect((await store.load(a.id))!.defaultWallHeight).toBe(245);
    expect((await store.load(b.id))!.defaultWallHeight).toBe(310);
  });

  it('survives a project package round trip in web.json', () => {
    const imported = readProjectPackage(projectPackageBytes(withHeight(245))).project;
    expect(imported.defaultWallHeight).toBe(245);
    expect(readProjectPackage(projectPackageBytes(withHeight())).project.defaultWallHeight).toBeUndefined();
  });
});
