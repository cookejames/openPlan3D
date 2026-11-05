import type { LandscapeArea, Point } from '$lib/models/types';

/** Distance (cm) under which two landscape corners or a corner and an edge count as touching. */
export const LANDSCAPE_EPS = 0.5;

/** Signed area in cm²; positive for counter-clockwise points in plan (x right, y down) maths order. */
export function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += points[j].x * points[i].y - points[i].x * points[j].y;
  }
  return sum / 2;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function onBoundary(p: Point, poly: Point[], eps: number): boolean {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distanceToSegment(p, poly[j], poly[i]) <= eps) return true;
  }
  return false;
}

function rayInside(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i].y > p.y) !== (poly[j].y > p.y) &&
        p.x < (poly[j].x - poly[i].x) * (p.y - poly[i].y) / (poly[j].y - poly[i].y) + poly[i].x) {
      inside = !inside;
    }
  }
  return inside;
}

/** True when p lies inside poly and further than eps from its boundary. */
export function strictlyInside(p: Point, poly: Point[], eps = LANDSCAPE_EPS): boolean {
  return !onBoundary(p, poly, eps) && rayInside(p, poly);
}

/** Drops repeated and collinear corners and orders the rest counter-clockwise. */
export function normalisePolygon(points: Point[], eps = LANDSCAPE_EPS): Point[] {
  let pts = points.map(p => ({ x: p.x, y: p.y }));
  pts = pts.filter((p, i) => {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    return pts.length < 2 || Math.hypot(p.x - prev.x, p.y - prev.y) > eps;
  });
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const next = pts[(i + 1) % pts.length];
      if (distanceToSegment(pts[i], prev, next) <= eps * 0.2) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (polygonArea(pts) < 0) pts.reverse();
  return pts;
}

function segmentsCrossProperly(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** At least three corners, non-zero area and no edge crossing a non-adjacent edge. */
export function isSimplePolygon(points: Point[]): boolean {
  const n = points.length;
  if (n < 3 || Math.abs(polygonArea(points)) < 1) return false;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const c = points[j], d = points[(j + 1) % n];
      if (segmentsCrossProperly(a, b, c, d)) return false;
    }
  }
  return true;
}

function samples(poly: Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    out.push(a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  const area = polygonArea(poly);
  if (Math.abs(area) > 1e-9) {
    let cx = 0, cy = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const f = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
      cx += (poly[j].x + poly[i].x) * f;
      cy += (poly[j].y + poly[i].y) * f;
    }
    out.push({ x: cx / (6 * area), y: cy / (6 * area) });
  }
  return out;
}

/** True when the interiors of a and b intersect. Shared edges and touching corners do not count. */
export function polygonsOverlap(a: Point[], b: Point[], eps = LANDSCAPE_EPS): boolean {
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const r = b[j], s = b[(j + 1) % b.length];
      if (segmentsCrossProperly(p, q, r, s) &&
          distanceToSegment(p, r, s) > eps && distanceToSegment(q, r, s) > eps &&
          distanceToSegment(r, p, q) > eps && distanceToSegment(s, p, q) > eps) return true;
    }
  }
  if (samples(a).some(p => strictlyInside(p, b, eps))) return true;
  if (samples(b).some(p => strictlyInside(p, a, eps))) return true;
  return false;
}

/** True when candidate overlaps any area not listed in ignoreIds. */
export function wouldOverlap(candidate: Point[], areas: LandscapeArea[], ignoreIds: Iterable<string> = []): boolean {
  const ignore = new Set(ignoreIds);
  return areas.some(area => !ignore.has(area.id) && polygonsOverlap(candidate, area.points));
}

/** Whether every area is a simple polygon and no two areas overlap. */
export function landscapeLayoutValid(areas: LandscapeArea[]): boolean {
  for (let i = 0; i < areas.length; i++) {
    if (!isSimplePolygon(areas[i].points)) return false;
    for (let j = i + 1; j < areas.length; j++) {
      if (polygonsOverlap(areas[i].points, areas[j].points)) return false;
    }
  }
  return true;
}

/** Nearest corner within radius, else nearest edge point within radius. `skip` excludes corners
 * (and the edges meeting them) that are being dragged, so they cannot snap to themselves. */
export function snapToLandscape(p: Point, areas: LandscapeArea[], radius: number,
  skip: (areaId: string, index: number) => boolean = () => false): Point | null {
  let best: Point | null = null, bestD = radius;
  for (const area of areas) area.points.forEach((c, i) => {
    if (skip(area.id, i)) return;
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d <= bestD) { bestD = d; best = { x: c.x, y: c.y }; }
  });
  if (best) return best;
  for (const area of areas) {
    const poly = area.points;
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      if (skip(area.id, i) || skip(area.id, j)) continue;
      const a = poly[i], b = poly[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (!len2) continue;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      const q = { x: a.x + t * dx, y: a.y + t * dy };
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d <= bestD) { bestD = d; best = q; }
    }
  }
  return best;
}

/** Every corner, on any area, lying within eps of p. */
export function cornersAt(p: Point, areas: LandscapeArea[], eps = LANDSCAPE_EPS): { areaId: string; index: number }[] {
  const out: { areaId: string; index: number }[] = [];
  for (const area of areas) area.points.forEach((c, index) => {
    if (Math.hypot(c.x - p.x, c.y - p.y) <= eps) out.push({ areaId: area.id, index });
  });
  return out;
}

/** Topmost area containing p (later areas are drawn last). */
export function findLandscapeAt(p: Point, areas: LandscapeArea[]): LandscapeArea | null {
  for (let i = areas.length - 1; i >= 0; i--) {
    if (rayInside(p, areas[i].points)) return areas[i];
  }
  return null;
}
