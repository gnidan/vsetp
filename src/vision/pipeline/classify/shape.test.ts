import { beforeAll, describe, expect, test } from "vitest";
import { renderCardRaster } from "../../../../test/synthetic/render";
import type { Card, Fill, Shape } from "../../../model";
import type { Cv } from "../../opencv/cv";
import { loadOpenCv } from "../../opencv/load-node";
import { segmentSymbols } from "../../opencv/segment";
import { classifyShape } from "./shape";

let cv: Cv;
beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000);

describe("classifyShape", () => {
  for (const shape of ["diamond", "oval", "squiggle"] as Shape[]) {
    for (const fill of ["solid", "striped", "open"] as Fill[]) {
      test(`${shape} (${fill})`, async () => {
        const card: Card = { count: 2, color: "red", shape, fill };
        const raster = await renderCardRaster(card);
        const result = classifyShape(segmentSymbols(cv, raster));
        expect(result.value).toBe(shape);
        expect(result.confidence).toBeGreaterThan(0.3);
        expect(result.confidence).toBeLessThanOrEqual(1);
      });
    }
  }

  test("returns zero confidence with no regions", () => {
    expect(classifyShape([]).confidence).toBe(0);
  });

  test("keeps confidence in 0..1 for a barely-convex 4-vertex region", () => {
    // hand-built region: rhombus outline (bbox fill 0.5, well inside
    // the diamond band) with solidity just above the 0.9 gate. The
    // raw diamond confidence exceeds 1 here unless clamped.
    // (This fixture was an axis-aligned SQUARE before the tuning
    // round; the bbox-fill discriminator added there — real stadium
    // ovals also simplify to 4 vertices — correctly refuses to call
    // a square a diamond, so the fixture became a true rhombus.)
    const outline = [
      { x: 50, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 100 },
      { x: 0, y: 50 },
    ];
    const hull = [
      { x: 50, y: -2.6 },
      { x: 102.6, y: 50 },
      { x: 50, y: 102.6 },
      { x: -2.6, y: 50 },
    ];
    const result = classifyShape([{ outline, hull }]);
    expect(result.value).toBe("diamond");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
