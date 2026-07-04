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
    // hand-built region: 4-vertex outline with solidity just above the
    // 0.9 diamond gate (~0.905) — the diamond confidence formula is
    // negative here unless clamped at 0
    const outline = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const hull = [
      { x: 0, y: 0 },
      { x: 105.1, y: 0 },
      { x: 105.1, y: 105.1 },
      { x: 0, y: 105.1 },
    ];
    const result = classifyShape([{ outline, hull }]);
    expect(result.value).toBe("diamond");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
