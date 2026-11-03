import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { mockStorage } from './fixtures/indexeddb';

const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

beforeEach(() => {
  vi.resetModules();
  // The store only touches storage in the browser.
  vi.stubGlobal('window', {});
});

afterEach(() => {
  if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

/** Blocked site data: reading localStorage itself throws, as browsers do when cookies are blocked. */
function blockStorage() {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('Access is denied for this document.', 'SecurityError'); },
  });
}

import { cycleSnapStep } from '../src/lib/utils/snapStep';

const load = async () => (await import('../src/lib/stores/settings')).projectSettings;

/** What S and the status-bar Snap button do. */
function switchSnapStep(settings: Awaited<ReturnType<typeof load>>) {
  settings.update(cycleSnapStep);
}

describe('editor settings', () => {
  it('switches the snap step for the session when site storage is blocked', async () => {
    blockStorage();
    const settings = await load();
    expect(get(settings).snapToGrid).toBe(true);
    expect(() => switchSnapStep(settings)).not.toThrow();
    expect(get(settings).snapToGrid).toBe(false);
    for (let i = 0; i < 3; i++) switchSnapStep(settings);
    expect(get(settings)).toMatchObject({ snapToGrid: true, snapStep: 'grid' });
  });

  it('migrates settings saved with only snapToGrid to the matching snap step', async () => {
    mockStorage().set('o3d_settings', JSON.stringify({ snapToGrid: false }));
    expect(get(await load())).toMatchObject({ snapToGrid: false, snapStep: 10 });
    vi.resetModules();
    mockStorage().set('o3d_settings', JSON.stringify({ snapToGrid: true }));
    expect(get(await load())).toMatchObject({ snapStep: 'grid' });
  });

  it('applies Settings changes for the session when site storage is blocked', async () => {
    blockStorage();
    const settings = await load();
    expect(() => settings.set({ ...get(settings), units: 'imperial', showInternalDimensions: true })).not.toThrow();
    expect(get(settings)).toMatchObject({ units: 'imperial', showInternalDimensions: true });
    expect(() => settings.reset()).not.toThrow();
    expect(get(settings)).toMatchObject({ units: 'metric', showInternalDimensions: false });
  });

  it('keeps changes that full storage could not save', async () => {
    const data = mockStorage();
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    const settings = await load();
    expect(() => switchSnapStep(settings)).not.toThrow();
    expect(() => settings.set({ ...get(settings), units: 'imperial' })).not.toThrow();
    expect(get(settings)).toMatchObject({ snapToGrid: false, units: 'imperial' });
    expect(data.has('o3d_settings')).toBe(false);
  });

  it('remembers changes across reloads when storage works', async () => {
    const data = mockStorage();
    const settings = await load();
    switchSnapStep(settings);
    expect(JSON.parse(data.get('o3d_settings')!)).toMatchObject({ snapToGrid: false });
    settings.set({ ...get(settings), units: 'imperial' });
    vi.resetModules();
    expect(get(await load())).toMatchObject({ snapToGrid: false, units: 'imperial' });
  });
});
