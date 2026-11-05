import type { Floor } from '$lib/models/types';

/** Content drawn by every plan exporter (PNG, PDF, SVG, DXF and Print Layout). */
export function hasPlanExportContent(floor: Floor): boolean {
  return floor.walls.length > 0 || floor.furniture.length > 0
    || !!floor.stairs?.length || !!floor.columns?.length
    || !!floor.measurements?.length
    || !!floor.landscape?.some(area => area.points.length >= 3)
    || !!floor.annotations?.some(a => Math.hypot(a.x2 - a.x1, a.y2 - a.y1) >= 1)
    || !!floor.textAnnotations?.some(note => note.text.trim().length > 0);
}
