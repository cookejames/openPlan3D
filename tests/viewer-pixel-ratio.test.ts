import { expect, it } from 'vitest';
import { MAX_VIEWER_PIXEL_RATIO, viewerPixelRatio } from '$lib/utils/viewerPixelRatio';

it('keeps desktop densities and caps phone densities', () => {
  expect(viewerPixelRatio(1)).toBe(1);
  expect(viewerPixelRatio(1.5)).toBe(1.5);
  expect(viewerPixelRatio(2)).toBe(2);
  for (const phone of [2.625, 3, 3.5]) expect(viewerPixelRatio(phone)).toBe(MAX_VIEWER_PIXEL_RATIO);
});

it('falls back to one device pixel for a missing or invalid ratio', () => {
  for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(viewerPixelRatio(ratio)).toBe(1);
});
