import type { LandscapeArea, Point } from '$lib/models/types';
import type { CanvasState } from '$lib/utils/canvasInteraction';
import { getLandscapeMaterial } from '$lib/utils/materials';
import { getLandscapeTextureCanvas } from '$lib/utils/textureGenerator';

/** World size (cm) one texture tile covers, in plan and in 3D, so both views agree. */
export const LANDSCAPE_TILE_CM = 200;
const SELECTION = '#3b82f6';

/** Draw in world centimetres for the duration of fn. */
function inWorld(cs: CanvasState, fn: () => void) {
  const { ctx, zoom } = cs;
  ctx.save();
  ctx.translate(cs.width / 2 - cs.camX * zoom, cs.height / 2 - cs.camY * zoom);
  ctx.scale(zoom, zoom);
  try { fn(); } finally { ctx.restore(); }
}

function trace(ctx: CanvasRenderingContext2D, points: Point[]) {
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

/** Fill an area's outline (already traced in world cm) with its surface: flat colour, then the photo on the world grid. */
function fillSurface(ctx: CanvasRenderingContext2D, surface: string) {
  ctx.fillStyle = getLandscapeMaterial(surface).color;
  ctx.fill();
  const tex = getLandscapeTextureCanvas(surface);
  const pattern = tex && ctx.createPattern(tex, 'repeat');
  if (!pattern) return;
  const s = LANDSCAPE_TILE_CM / tex!.width;
  pattern.setTransform(new DOMMatrix().scale(s, s));
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = pattern;
  ctx.fill();
  ctx.restore();
}

/** The project's default ground over the whole view, on the same world grid as the areas so they join seamlessly. */
export function drawLandscapeGround(cs: CanvasState, surface: string) {
  const { ctx, zoom } = cs;
  inWorld(cs, () => {
    const x = cs.camX - cs.width / 2 / zoom, y = cs.camY - cs.height / 2 / zoom;
    ctx.beginPath();
    ctx.rect(x, y, cs.width / zoom, cs.height / zoom);
    fillSurface(ctx, surface);
  });
}

/** Fill each area with its surface texture (world-anchored, so neighbours tile seamlessly) and outline it.
 *  `clip`, given, sets a screen-space clip for the fills only, so selection handles stay visible. */
export function drawLandscape(cs: CanvasState, areas: LandscapeArea[], selectedIds: ReadonlySet<string>, clip?: () => void) {
  if (!areas.length) return;
  const { ctx, zoom } = cs;
  ctx.save();
  clip?.();
  inWorld(cs, () => {
    for (const area of areas) {
      if (area.points.length < 3) continue;
      trace(ctx, area.points);
      fillSurface(ctx, area.surface);
      ctx.lineWidth = 1 / zoom;
      ctx.strokeStyle = 'rgba(30, 41, 59, 0.45)';
      ctx.stroke();
    }
  });
  ctx.restore();
  inWorld(cs, () => {
    for (const area of areas) {
      if (!selectedIds.has(area.id)) continue;
      trace(ctx, area.points);
      ctx.lineWidth = 2 / zoom;
      ctx.strokeStyle = SELECTION;
      ctx.stroke();
      const r = 4 / zoom;
      for (const p of area.points) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
        ctx.lineWidth = 1.5 / zoom;
        ctx.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
      }
    }
  });
}

/** Where an area's name is drawn: the centre of its bounding box. */
export function landscapeLabelPosition(area: LandscapeArea): Point {
  const xs = area.points.map(p => p.x), ys = area.points.map(p => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/** Names of named areas at their bounding-box centre, drawn in screen space above the plan. */
export function drawLandscapeLabels(cs: CanvasState, areas: LandscapeArea[]) {
  const { ctx } = cs;
  ctx.save();
  ctx.font = '500 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const area of areas) {
    if (!area.name?.trim() || area.points.length < 3) continue;
    const { x: cx, y: cy } = landscapeLabelPosition(area);
    const sx = (cx - cs.camX) * cs.zoom + cs.width / 2, sy = (cy - cs.camY) * cs.zoom + cs.height / 2;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.strokeText(area.name, sx, sy);
    ctx.fillStyle = '#1e293b';
    ctx.fillText(area.name, sx, sy);
  }
  ctx.restore();
}

/** The outline being drawn with the landscape tool: placed corners, then the cursor, closing back to the start. */
export function drawLandscapePreview(cs: CanvasState, points: Point[], cursor: Point | null, surface: string, closing: boolean) {
  const pts = cursor && !closing ? [...points, cursor] : points;
  if (!pts.length) return;
  const { ctx, zoom } = cs;
  inWorld(cs, () => {
    if (pts.length >= 3) {
      trace(ctx, pts);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = getLandscapeMaterial(surface).color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.lineWidth = 2 / zoom;
    ctx.strokeStyle = SELECTION;
    ctx.stroke();
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.lineTo(pts[0].x, pts[0].y);
      ctx.setLineDash([6 / zoom, 4 / zoom]);
      ctx.lineWidth = 1 / zoom;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const r = 4 / zoom;
    points.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, i === 0 && closing ? r * 2 : r, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? SELECTION : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 1.5 / zoom;
      ctx.strokeStyle = SELECTION;
      ctx.stroke();
    });
  });
}
