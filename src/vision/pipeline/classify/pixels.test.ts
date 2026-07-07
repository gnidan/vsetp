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

describe("withoutRingHuggers", () => {
  test("drops a region whose bbox hugs the border ring", () => {
    // 100x100 raster: BORDER_RING (5%) puts the ring boundary at 5px
    const raster = new ImageData(100, 100);
    const plausible = [
      squareRegion(20, 20, 15),
      squareRegion(50, 20, 15),
      squareRegion(20, 50, 15),
    ];
    // tall sliver whose bbox reaches the left ring boundary (x=0..3,
    // ring starts at x=5) — off-card intrusion, never a real symbol
    const sliver: SymbolRegion = {
      outline: [
        { x: 0, y: 10 },
        { x: 3, y: 10 },
        { x: 3, y: 90 },
        { x: 0, y: 90 },
      ],
      hull: [],
    };

    const filtered = withoutRingHuggers([...plausible, sliver], raster);
    expect(filtered).toEqual(plausible);
  });

  test("keeps every region when none touch the ring", () => {
    const raster = new ImageData(100, 100);
    const plausible = [squareRegion(20, 20, 15), squareRegion(50, 50, 15)];
    expect(withoutRingHuggers(plausible, raster)).toEqual(plausible);
  });
});
