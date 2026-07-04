import { beforeAll, describe, expect, test } from "vitest";
import { renderCardRaster } from "../../../../test/synthetic/render";
import type { Card, Color, Fill, Shape } from "../../../model";
import type { Cv } from "../../opencv/cv";
import { loadOpenCv } from "../../opencv/load-node";
import { segmentSymbols } from "../../opencv/segment";
import { classifyFill } from "./fill";

let cv: Cv;
beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000);

describe("classifyFill", () => {
  for (const fill of ["solid", "striped", "open"] as Fill[]) {
    for (const color of ["red", "green", "purple"] as Color[]) {
      for (const shape of ["oval", "diamond", "squiggle"] as Shape[]) {
        test(`${fill} ${color} ${shape}`, async () => {
          const card: Card = { count: 1, color, shape, fill };
          const raster = await renderCardRaster(card);
          const result = classifyFill(raster, segmentSymbols(cv, raster));
          expect(result.value).toBe(fill);
          expect(result.confidence).toBeGreaterThan(0.3);
        });
      }
    }
  }

  test("returns zero confidence with no regions", async () => {
    const raster = await renderCardRaster({
      count: 1,
      color: "red",
      shape: "oval",
      fill: "solid",
    });
    expect(classifyFill(raster, []).confidence).toBe(0);
  });
});
