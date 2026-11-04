import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { addWall, createDefaultProject, currentProject, splitWall, undo } from '$lib/stores/project';
import { DEFAULT_WALL_HEIGHT, projectSettings } from '$lib/stores/settings';
import { placePreset, roomPresets } from '$lib/utils/roomPresets';

const walls = () => get(currentProject)!.floors[0].walls;
const setDefaultHeight = (defaultWallHeight: number) => projectSettings.update(s => ({ ...s, defaultWallHeight }));

beforeEach(() => {
  projectSettings.reset();
  currentProject.set(createDefaultProject('Default wall height'));
});
afterEach(() => projectSettings.reset());

describe('Default wall height', () => {
  it('gives drawn walls 280 cm until the setting changes', () => {
    expect(get(projectSettings).defaultWallHeight).toBe(DEFAULT_WALL_HEIGHT);
    addWall({ x: 0, y: 0 }, { x: 300, y: 0 });
    expect(walls()[0]).toMatchObject({ height: 280, startHeight: 280, endHeight: 280 });
  });

  it('gives new walls the chosen height and leaves existing walls unchanged', () => {
    const first = addWall({ x: 0, y: 0 }, { x: 300, y: 0 });
    setDefaultHeight(240);
    const second = addWall({ x: 300, y: 0 }, { x: 300, y: 300 });
    expect(walls().find(w => w.id === first)).toMatchObject({ height: 280, startHeight: 280, endHeight: 280 });
    expect(walls().find(w => w.id === second)).toMatchObject({ height: 240, startHeight: 240, endHeight: 240 });
  });

  it('applies to room presets drawn as walls', () => {
    setDefaultHeight(310);
    placePreset(roomPresets[0], { x: 0, y: 0 });
    expect(walls().length).toBeGreaterThan(0);
    for (const wall of walls()) expect(wall).toMatchObject({ height: 310, startHeight: 310, endHeight: 310 });
  });

  it('keeps the height of an existing wall that is split', () => {
    const id = addWall({ x: 0, y: 0 }, { x: 400, y: 0 });
    setDefaultHeight(200);
    splitWall(id, 0.5);
    expect(walls()).toHaveLength(2);
    for (const wall of walls()) expect(wall).toMatchObject({ startHeight: 280, endHeight: 280 });
  });

  it('removes a new wall with one Undo', () => {
    setDefaultHeight(250);
    addWall({ x: 0, y: 0 }, { x: 300, y: 0 });
    undo();
    expect(walls()).toHaveLength(0);
  });
});
