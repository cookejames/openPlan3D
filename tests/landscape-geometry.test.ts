import { describe, expect, it } from 'vitest';
import { isSimplePolygon, normalisePolygon, polygonArea, polygonsOverlap, snapToLandscape, wouldOverlap } from '$lib/utils/landscapeGeometry';
import type { LandscapeArea, Point } from '$lib/models/types';

const rect = (x: number, y: number, w: number, h: number): Point[] =>
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

describe('landscape geometry', () => {
  it('allows areas that share an edge or a corner', () => {
    expect(polygonsOverlap(rect(0, 0, 100, 100), rect(100, 0, 100, 100))).toBe(false);
    expect(polygonsOverlap(rect(0, 0, 100, 100), rect(100, 100, 50, 50))).toBe(false);
  });

  it('allows a T-junction where a corner lies on a neighbour edge', () => {
    expect(polygonsOverlap(rect(0, 0, 200, 100), rect(50, 100, 100, 100))).toBe(false);
    expect(polygonsOverlap(rect(0, 100, 100, 100), rect(0, 0, 300, 100))).toBe(false);
  });

  it('detects nested, crossing, partial and identical areas', () => {
    expect(polygonsOverlap(rect(0, 0, 300, 300), rect(100, 100, 50, 50))).toBe(true);
    expect(polygonsOverlap(rect(0, 100, 300, 50), rect(100, 0, 50, 300))).toBe(true);
    expect(polygonsOverlap(rect(0, 0, 100, 100), rect(50, 50, 100, 100))).toBe(true);
    expect(polygonsOverlap(rect(0, 0, 100, 100), rect(0, 0, 100, 100))).toBe(true);
  });

  it('ignores listed areas when checking a candidate', () => {
    const areas: LandscapeArea[] = [{ id: 'a', points: rect(0, 0, 100, 100), surface: 'grass' }];
    expect(wouldOverlap(rect(50, 0, 100, 100), areas)).toBe(true);
    expect(wouldOverlap(rect(50, 0, 100, 100), areas, ['a'])).toBe(false);
  });

  it('normalises corners counter-clockwise without duplicates or collinear points', () => {
    const pts = normalisePolygon([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 50 }, { x: 100, y: 0 }]);
    expect(pts).toHaveLength(4);
    expect(polygonArea(pts)).toBeGreaterThan(0);
  });

  it('rejects self-intersecting and degenerate outlines', () => {
    expect(isSimplePolygon([{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }])).toBe(false);
    expect(isSimplePolygon([{ x: 0, y: 0 }, { x: 100, y: 0 }])).toBe(false);
    expect(isSimplePolygon(rect(0, 0, 10, 10))).toBe(true);
  });

  it('snaps to corners before edges', () => {
    const areas: LandscapeArea[] = [{ id: 'a', points: rect(0, 0, 100, 100), surface: 'grass' }];
    expect(snapToLandscape({ x: 103, y: 2 }, areas, 10)).toEqual({ x: 100, y: 0 });
    expect(snapToLandscape({ x: 104, y: 50 }, areas, 10)).toEqual({ x: 100, y: 50 });
    expect(snapToLandscape({ x: 150, y: 50 }, areas, 10)).toBeNull();
  });
});
