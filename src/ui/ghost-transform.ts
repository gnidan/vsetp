import type { Quad } from "../model";
import { CARD_RASTER } from "../vision/adapter";
import { rectToQuad, toMatrix3d } from "./homography";

// Shared ghost positioning (Overlay for stills, TrackGhosts live):
// the CSS matrix3d that maps a CARD_RASTER-sized element onto a
// detected quad in frame coordinates.
export function ghostTransform(quad: Quad): string {
  return toMatrix3d(rectToQuad(CARD_RASTER.width, CARD_RASTER.height, quad));
}

// Quad corners as an SVG <polygon> points string.
export function quadPoints(quad: Quad): string {
  return quad.map((p) => `${p.x},${p.y}`).join(" ");
}
