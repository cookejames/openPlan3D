import { beforeEach, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { FurnitureItem, Project } from '$lib/models/types';
import { MAX_FURNITURE_ELEVATION } from '$lib/models/types';
import { currentProject, duplicateFurniture, loadProject, redo, undo, updateFurniture } from '$lib/stores/project';
import { createPlacedFurnitureModel } from '$lib/utils/furnitureModelLoader';
import { projectToPreparedRoomPlan } from '$lib/utils/interchange';
import { applyNativeEdits, nativeToWeb, webToNative } from '$lib/utils/projectPackageBridge';
import { readProject } from '$lib/utils/projectValidation';
import { createProjectFromRoomPlan } from '$lib/utils/roomplanImport';
import { roomProject } from './fixtures/project';

const cabinet = (extra: Partial<FurnitureItem> = {}): FurnitureItem => ({
  id: 'cabinet', catalogId: 'desk', position: { x: 200, y: 150 }, rotation: 0,
  scale: { x: 1, y: 1, z: 1 }, width: 80, depth: 35, height: 70, ...extra,
});
function withCabinet(extra: Partial<FurnitureItem> = {}): Project {
  const project = roomProject();
  project.floors[0].furniture = [cabinet(extra)];
  return project;
}
const item = () => get(currentProject)!.floors[0].furniture[0];

beforeEach(() => loadProject(withCabinet()));

it('accepts absent, zero and positive elevations and rejects invalid ones', () => {
  expect(readProject(withCabinet()).floors[0].furniture[0].elevation).toBeUndefined();
  expect(readProject(withCabinet({ elevation: 0 })).floors[0].furniture[0].elevation).toBe(0);
  expect(readProject(withCabinet({ elevation: 145.5 })).floors[0].furniture[0].elevation).toBe(145.5);
  expect(readProject(withCabinet({ elevation: MAX_FURNITURE_ELEVATION })).floors[0].furniture[0].elevation).toBe(MAX_FURNITURE_ELEVATION);
  for (const elevation of [-1, Number.NaN, Infinity, MAX_FURNITURE_ELEVATION + 1, '120', null]) {
    expect(() => readProject(withCabinet({ elevation: elevation as number }))).toThrow(/elevation/);
  }
});

it('updates elevation with Undo/Redo and keeps it on duplicate and save/reload', () => {
  updateFurniture('cabinet', { elevation: 140 });
  expect(item().elevation).toBe(140);
  undo();
  expect(item().elevation).toBeUndefined();
  redo();
  expect(item().elevation).toBe(140);

  const copyId = duplicateFurniture('cabinet')!;
  expect(get(currentProject)!.floors[0].furniture.find(f => f.id === copyId)!.elevation).toBe(140);

  const reloaded = readProject(JSON.parse(JSON.stringify(get(currentProject))));
  expect(reloaded.floors[0].furniture[0].elevation).toBe(140);
});

it('raises the 3D model by the elevation', () => {
  const floor = createPlacedFurnitureModel(cabinet())!;
  const raised = createPlacedFurnitureModel(cabinet({ elevation: 140 }))!;
  expect(raised.position.y - floor.position.y).toBeCloseTo(140);
  expect(raised.position.x).toBe(floor.position.x);
  expect(raised.position.z).toBe(floor.position.z);
});

it('writes elevation into prepared interchange and reads it back', () => {
  const data = projectToPreparedRoomPlan(withCabinet({ elevation: 140 })) as any;
  const object = data.objects.find((o: any) => o.identifier === 'cabinet');
  expect(object.transform[13]).toBeCloseTo(1.4 + 0.35);
  const back = createProjectFromRoomPlan(data, 'Back').floors[0].furniture.find(f => f.id === 'cabinet')!;
  expect(back.elevation).toBeCloseTo(140);

  const grounded = createProjectFromRoomPlan(projectToPreparedRoomPlan(withCabinet()) as any, 'Back').floors[0].furniture.find(f => f.id === 'cabinet')!;
  expect(grounded.elevation).toBeUndefined();
});

it('leaves raw scan objects on the floor', () => {
  const data = projectToPreparedRoomPlan(withCabinet({ elevation: 140 })) as any;
  delete data.openplanPrepared;
  delete data.openplanHandoffVersion;
  const back = createProjectFromRoomPlan(data, 'Back').floors[0].furniture.find(f => f.id === 'cabinet')!;
  expect(back.elevation).toBeUndefined();
});

it('retains elevation when native edits return through a project package', () => {
  const source = withCabinet({ elevation: 140 });
  const { plan, mapping } = webToNative(source, undefined);
  const before = nativeToWeb(plan, mapping, source.name);
  const edited = structuredClone(plan);
  edited.furniture[0].angle = Math.PI / 2;
  const merged = applyNativeEdits(source, before, nativeToWeb(edited, mapping, source.name));
  expect(merged.floors[0].furniture[0]).toMatchObject({ elevation: 140 });
  expect(merged.floors[0].furniture[0].rotation).toBeCloseTo(90);
});
