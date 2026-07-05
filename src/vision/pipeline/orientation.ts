import type { Point, Quad } from "../../model";
import type { SymbolRegion } from "../adapter";
import { AREA_CONSISTENCY } from "./classify/count";
import { polygonArea } from "./regions";

// Geometric corner ordering (vision/quad.ts) puts the longest MEASURED
// edge on top, assuming it is a long PHYSICAL edge of the card. Under
// strong foreshortening (far table rows shot at a low angle) the short
// physical edge can measure longest, so the card rectifies sideways.
// Classification never notices — all four classifiers are
// orientation-invariant — but anything that projects content back onto
// the quad (ghost overlays) renders 90 degrees off. These helpers
// content-verify orientation from the segmented symbol regions.

// Trust floor for the single-symbol principal-axis test, as a major/
// minor eigenvalue ratio in raster-normalized coordinates. Measured
// across the tuning fixtures: real single-symbol regions read 6.5-14.1
// on upright rasters and 9.3-10.8 on sideways ones — never anywhere
// near isotropic. A region below 2 (a blurred blob, a near-square
// fragment) carries no trustworthy axis: keep the geometric order.
const MIN_AXIS_ANISOTROPY = 2;

function centroidOf(outline: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of outline) {
    x += p.x;
    y += p.y;
  }
  return { x: x / outline.length, y: y / outline.length };
}

// Same debris rejection classifyCount applies before tallying:
// regions far from the median area are glare blobs or broken-stroke
// fragments, not symbols. Without this a thin sliver next to one real
// symbol reads as a two-region "row" whose axis points anywhere
// (pic2934145's 1-green-squiggle-open flipped exactly this way).
function plausibleSymbols(regions: SymbolRegion[]): SymbolRegion[] {
  if (regions.length <= 1) return regions;
  const areas = regions.map((r) => polygonArea(r.outline));
  const median = [...areas].sort((a, b) => a - b)[Math.floor(areas.length / 2)];
  return regions.filter(
    (_, i) =>
      areas[i] >= median * AREA_CONSISTENCY.min &&
      areas[i] <= median * AREA_CONSISTENCY.max,
  );
}

// Principal axis of the outline points via second moments, in
// raster-normalized coordinates (so the rectifier's anisotropic
// scaling factors out). Horizontal-dominant axis means sideways —
// but only when the eigenvalue ratio clears MIN_AXIS_ANISOTROPY;
// a near-isotropic region gets no vote.
function principalAxisIsHorizontal(
  outline: Point[],
  raster: { width: number; height: number },
): boolean {
  const c = centroidOf(outline);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of outline) {
    const dx = (p.x - c.x) / raster.width;
    const dy = (p.y - c.y) / raster.height;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const mean = (sxx + syy) / 2;
  const spread = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2);
  const major = mean + spread;
  const minor = mean - spread;
  if (major <= 0 || major < minor * MIN_AXIS_ANISOTROPY) return false;
  // the principal axis lies within 45 degrees of horizontal exactly
  // when the x-variance dominates (2*theta = atan2(2*sxy, sxx - syy))
  return sxx > syy;
}

// Is the rectified card raster sideways (card long axis running down
// the raster instead of across it)? Comparisons are normalized by the
// raster dimensions so an upright N-symbol row and its sideways
// counterpart give mirror-image measurements.
export function isSideways(
  regions: SymbolRegion[],
  raster: { width: number; height: number },
): boolean {
  const symbols = plausibleSymbols(regions);
  if (symbols.length === 0) return false;
  if (symbols.length === 1) {
    // one symbol: no row axis to read, but the symbol itself is
    // clearly elongated along the card's short axis when upright
    return principalAxisIsHorizontal(symbols[0].outline, raster);
  }
  // two or more symbols: the row of centroids runs along the card's
  // long axis, which is the raster x axis when upright
  const centroids = symbols.map((r) => centroidOf(r.outline));
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
