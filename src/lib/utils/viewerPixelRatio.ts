/** Phones report 2.6–3.5 device pixels per CSS pixel. At that density the main viewer's
 * antialiased, preserved drawing buffer, plus the copies the compositor keeps in flight while
 * an orbit renders every frame, exhausts mobile GPU memory and the browser drops the context. */
export const MAX_VIEWER_PIXEL_RATIO = 2;

export function viewerPixelRatio(devicePixelRatio: number): number {
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? Math.min(devicePixelRatio, MAX_VIEWER_PIXEL_RATIO) : 1;
}
