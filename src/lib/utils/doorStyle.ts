import type { Door, Window } from '$lib/models/types';

/** Glazed door types get metal-framed glass leaves in 3D. */
export function isGlazedDoor(type: Door['type']): boolean {
  return type === 'sliding' || type === 'french' || type === 'bifold';
}

/** Frame colour used when a door has no `frameColor`: aluminium for glazed doors, wood otherwise. */
export function defaultDoorFrameColor(type: Door['type']): string {
  return isGlazedDoor(type) ? '#B4B9BE' : '#6B4423';
}

export function doorFrameColor(door: Pick<Door, 'type' | 'frameColor'>): string {
  return door.frameColor ?? defaultDoorFrameColor(door.type);
}

/** Frame colour used when a window has no `frameColor`: the White preset. */
export const DEFAULT_WINDOW_FRAME_COLOR = '#F4F5F0';

export function windowFrameColor(win: Pick<Window, 'frameColor'>): string {
  return win.frameColor ?? DEFAULT_WINDOW_FRAME_COLOR;
}

/** Lights in a UK side-hung casement window: one per ~65 cm of width (60 cm → 1,
 * 100–130 cm → 2, 150–195 cm → 3), capped at 6. */
export function casementLightCount(width: number): number {
  return Math.max(1, Math.min(6, Math.ceil(width / 65)));
}

/** Swatches offered for door and window frames; `key` names a `doorFrameColor.*` label. */
export const FRAME_COLOR_PRESETS = [
  { key: 'AnthraciteGrey', color: '#3B3F46' },
  { key: 'Black', color: '#1A1A1A' },
  { key: 'White', color: '#F4F5F0' },
  { key: 'ChartwellGreen', color: '#98B49E' },
  { key: 'SageGreen', color: '#7C8D79' },
  { key: 'AgateGrey', color: '#B1B3A7' },
  { key: 'Aluminium', color: '#B4B9BE' },
  { key: 'Cream', color: '#ECE6D3' },
  { key: 'Oak', color: '#BC8A4E' },
  { key: 'Rosewood', color: '#4A2A22' },
  { key: 'Mahogany', color: '#5C2516' },
  { key: 'Walnut', color: '#3D2B1F' },
  { key: 'Teak', color: '#8E5929' },
  { key: 'Brown', color: '#6B4423' },
] as const;
