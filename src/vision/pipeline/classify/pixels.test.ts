import { describe, expect, test } from "vitest";
import type { Point } from "../../../model";
import type { SymbolRegion } from "../../adapter";
import { withoutRingHuggers } from "./pixels";

function squareRegion(x0: number, y0: number, size: number): SymbolRegion {
  const outline: Point[] = [
    { x: x0, y: y0 },
    { x: x0 + size, y: y0 },
    { x: x0 + size, y: y0 + size },
    { x: x0, y: y0 + size },
  ];
  return { outline, hull: outline };
}

// axis-aligned rectangle region, inclusive pixel-coordinate corners
function rectRegion(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): SymbolRegion {
  const outline: Point[] = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  return { outline, hull: outline };
}

describe("withoutRingHuggers", () => {
  // 100x100 raster: BORDER_RING (5%) gives rx = ry = 5, so the pixels
  // surviving segmentation's ring blank span [5, 94] in each axis
  // (the blank rectangle is corner-inclusive; see segment.ts). An
  // off-card strip runs the full raster dimension, so the blank clips
  // it flush on THREE edges; a real symbol clipped by the blank
  // touches exactly one (see withoutRingHuggers).
  const raster = new ImageData(100, 100);

  test("drops an intruding strip flush at each of the four edges", () => {
    const strips = {
      left: rectRegion(5, 5, 8, 94), // flush left + top + bottom
      right: rectRegion(91, 5, 94, 94), // flush right + top + bottom
      top: rectRegion(5, 5, 94, 8), // flush top + left + right
      bottom: rectRegion(5, 91, 94, 94), // flush bottom + left + right
    };
    for (const [edge, strip] of Object.entries(strips)) {
      const kept = [squareRegion(30, 30, 20), squareRegion(60, 60, 20)];
      const filtered = withoutRingHuggers([...kept, strip], raster);
      expect(filtered, `${edge}-edge strip must be dropped`).toEqual(kept);
    }
  });

  test("drops a corner blob flush on two edges", () => {
    const blob = rectRegion(5, 5, 20, 20);
    const kept = [squareRegion(40, 40, 20)];
    expect(withoutRingHuggers([...kept, blob], raster)).toEqual(kept);
  });

  test("drops a region poking past the surviving rect", () => {
    // bbox reaches x=0..3, entirely inside the blanked band — cannot
    // come out of a ring-blanking segmentation, certainly off-card if
    // one ever hands it over
    const sliver = rectRegion(0, 10, 3, 90);
    const kept = [squareRegion(30, 30, 20)];
    expect(withoutRingHuggers([...kept, sliver], raster)).toEqual(kept);
  });

  test("keeps a real symbol clipped flush on a single edge", () => {
    // pic1014255's third squiggle: a real symbol on a well-quadded
    // fixture, clipped flush against the LAST surviving column only
    const clipped = rectRegion(60, 30, 94, 70);
    expect(withoutRingHuggers([clipped], raster)).toEqual([clipped]);
  });

  test("keeps an interior symbol 10px inside the ring on each side", () => {
    // bbox [15, 84] in both axes: 10px clear of the ring everywhere
    const interior = rectRegion(15, 15, 84, 84);
    expect(withoutRingHuggers([interior], raster)).toEqual([interior]);
  });

  test("keeps every region when none touch the ring", () => {
    const plausible = [squareRegion(20, 20, 15), squareRegion(50, 50, 15)];
    expect(withoutRingHuggers(plausible, raster)).toEqual(plausible);
  });
});
