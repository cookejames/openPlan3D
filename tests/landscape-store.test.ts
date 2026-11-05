import { beforeEach, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  currentProject, createDefaultProject, addLandscapeArea, updateLandscapeArea, removeElement,
  moveLandscapeArea, moveLandscapeVertices, landscapeIsValid, beginUndoGroup, endUndoGroup, undo, redo,
} from '$lib/stores/project';
import { readProject } from '$lib/utils/projectValidation';
import type { Point } from '$lib/models/types';

const rect = (x: number, y: number, w: number, h: number): Point[] =>
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const areas = () => get(currentProject)!.floors[0].landscape ?? [];

beforeEach(() => currentProject.set(createDefaultProject()));

it('adds, retextures and deletes areas as undoable steps', () => {
  const id = addLandscapeArea(rect(0, 0, 400, 300), 'grass')!;
  expect(id).toBeTruthy();
  expect(areas()).toHaveLength(1);
  updateLandscapeArea(id, { surface: 'gravel' });
  expect(areas()[0].surface).toBe('gravel');
  removeElement(id);
  expect(areas()).toHaveLength(0);
  undo(); expect(areas()[0].surface).toBe('gravel');
  undo(); expect(areas()[0].surface).toBe('grass');
  undo(); expect(areas()).toHaveLength(0);
  redo(); expect(areas()).toHaveLength(1);
});

it('accepts areas sharing an edge and rejects overlaps', () => {
  expect(addLandscapeArea(rect(0, 0, 100, 100), 'grass')).toBeTruthy();
  expect(addLandscapeArea(rect(100, 0, 100, 100), 'tarmac')).toBeTruthy();
  expect(addLandscapeArea(rect(150, 50, 100, 100), 'soil')).toBeNull();
  expect(addLandscapeArea([{ x: 0, y: 0 }, { x: 10, y: 0 }], 'soil')).toBeNull();
  expect(areas()).toHaveLength(2);
});

it('reports overlap after a drag so the caller can revert it', () => {
  const a = addLandscapeArea(rect(0, 0, 100, 100), 'grass')!;
  const b = addLandscapeArea(rect(100, 0, 100, 100), 'tarmac')!;
  beginUndoGroup();
  moveLandscapeArea(a, 50, 0);
  endUndoGroup('Moved landscape area');
  expect(landscapeIsValid()).toBe(false);
  undo();
  expect(areas()[0].points[0]).toEqual({ x: 0, y: 0 });
  beginUndoGroup();
  // Shared corner of both areas moves together and the layout stays valid.
  const shared = [{ areaId: a, index: areas()[0].points.findIndex(p => p.x === 100 && p.y === 0) },
    { areaId: b, index: areas()[1].points.findIndex(p => p.x === 100 && p.y === 0) }];
  moveLandscapeVertices(shared, { x: 120, y: 0 });
  endUndoGroup('Reshaped landscape area');
  expect(landscapeIsValid()).toBe(true);
});

it('reads landscape areas from files and tolerates unknown surfaces', () => {
  addLandscapeArea(rect(0, 0, 100, 100), 'grass');
  const json = JSON.parse(JSON.stringify(get(currentProject)));
  json.floors[0].landscape[0].surface = 'moss';
  expect(readProject(json).floors[0].landscape![0].surface).toBe('grass');
  json.floors[0].landscape[0].points = [{ x: 0, y: 0 }];
  expect(() => readProject(json)).toThrow(/points/);
  delete json.floors[0].landscape;
  expect(readProject(json).floors[0].landscape).toBeUndefined();
});
