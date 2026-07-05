import type { Point, Quad } from "../../model";
import type { SymbolRegion } from "../adapter";

// Geometric corner ordering (vision/quad.ts) puts the longest MEASURED
// edge on top, assuming it is a long PHYSICAL edge of the card. Under
// strong foreshortening (far table rows shot at a low angle) the short
// physical edge can measure longest, so the card rectifies sideways.
// Classification never notices — all four classifiers are
// orientation-invariant — but anything that projects content back onto
// the quad (ghost overlays) renders 90 degrees off. These helpers
// content-verify orientation from the segmented symbol regions.

function centroidOf(outline: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of outline) {
    x += p.x;
    y += p.y;
  }
  return { x: x / outline.length, y: y / outline.length };
}

// Is the rectified card raster sideways (card long axis running down
// the raster instead of across it)? Comparisons are normalized by the
// raster dimensions so the rectifier's anisotropic scaling factors
// out: an upright N-symbol row and its sideways counterpart give
// mirror-image measurements.
export function isSideways(
  regions: SymbolRegion[],
  raster: { width: number; height: number },
): boolean {
  if (regions.length === 0) return false;
  if (regions.length === 1) {
    // one symbol: no row axis to read, but the symbol box itself is
    // taller than wide on an upright card (canonical 120x240)
    const xs = regions[0].outline.map((p) => p.x);
    const ys = regions[0].outline.map((p) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    return width / raster.width > height / raster.height;
  }
  // two or more symbols: the row of centroids runs along the card's
  // long axis, which is the raster x axis when upright
  const centroids = regions.map((r) => centroidOf(r.outline));
  const xs = centroids.map((c) => c.x);
  const ys = centroids.map((c) => c.y);
  const spreadX = (Math.max(...xs) - Math.min(...xs)) / raster.width;
  const spreadY = (Math.max(...ys) - Math.min(...ys)) / raster.height;
  return spreadY > spreadX;
}

// Content-verified corner ordering: if the rectified raster came out
// sideways, rotate the corner ordering one position forward so
// q0 -> q1 is a true long (top) edge of the upright card face. The
// forward direction is an arbitrary-but-deterministic pick: it leaves
// a 180-degree ambiguity, which is invisible — every Set glyph is
// 180-degree rotationally symmetric, so both uprights render
// identically. Callers should NOT re-rectify: classification already
// ran fine on the sideways raster.
export function orientQuad(
  quad: Quad,
  regions: SymbolRegion[],
  raster: { width: number; height: number },
): Quad {
  if (!isSideways(regions, raster)) return quad;
  return [quad[1], quad[2], quad[3], quad[0]];
}
