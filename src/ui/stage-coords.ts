import type { Point, Quad } from "../model";
import { coverTransform } from "./homography";

// Grip margin: taps this close to a stage edge never open the
// empty-space (missed-card) sheet — one-handed grip grazes must not
// pollute the export corpus (spec).
export const EDGE_NO_FIRE_PX = 24;

// Touch-target floor (spec: binding) and the always-on padding a hit
// area gets beyond a track's rendered bounds. Both in CLIENT px; the
// frame-space equivalents divide by the stage scale.
export const MIN_HIT_CLIENT_PX = 44;
export const HIT_PADDING_CLIENT_PX = 8;

// Client point → live-frame coordinates: invert the frame-space
// wrapper transform LiveView derives from coverTransform (translate
// offsets then scale), clamped to the frame bounds.
export function domToFrame(
  point: { x: number; y: number },
  stageRect: DOMRect,
  frameSize: { width: number; height: number },
): Point {
  const t = coverTransform(frameSize, {
    width: stageRect.width,
    height: stageRect.height,
  });
  const x = (point.x - stageRect.left - t.offsetX) / t.scale;
  const y = (point.y - stageRect.top - t.offsetY) / t.scale;
  return {
    x: Math.min(Math.max(x, 0), frameSize.width),
    y: Math.min(Math.max(y, 0), frameSize.height),
  };
}

export function inNoFireZone(
  point: { x: number; y: number },
  stageRect: DOMRect,
): boolean {
  return (
    point.x - stageRect.left < EDGE_NO_FIRE_PX ||
    stageRect.right - point.x < EDGE_NO_FIRE_PX ||
    point.y - stageRect.top < EDGE_NO_FIRE_PX ||
    stageRect.bottom - point.y < EDGE_NO_FIRE_PX
  );
}

// A track's expanded hit box in FRAME coordinates: the quad's
// bounding box padded on every side, then grown (centered) until it
// meets the 44pt client floor at the given frame→client scale.
export function expandedHitBox(
  quad: Quad,
  scale: number,
): { left: number; top: number; width: number; height: number } {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const pad = HIT_PADDING_CLIENT_PX / scale;
  const min = MIN_HIT_CLIENT_PX / scale;
  let left = Math.min(...xs) - pad;
  let top = Math.min(...ys) - pad;
  let width = Math.max(...xs) - Math.min(...xs) + 2 * pad;
  let height = Math.max(...ys) - Math.min(...ys) + 2 * pad;
  if (width < min) {
    left -= (min - width) / 2;
    width = min;
  }
  if (height < min) {
    top -= (min - height) / 2;
    height = min;
  }
  return { left, top, width, height };
}
