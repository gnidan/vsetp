import { beforeAll, describe, expect, test } from "vitest";
import { renderCardRaster } from "../../../../test/synthetic/render";
import type { Card, Color } from "../../../model";
import type { Cv } from "../../opencv/cv";
import { loadOpenCv } from "../../opencv/load-node";
import { segmentSymbols } from "../../opencv/segment";
import { classifyColor } from "./color";

let cv: Cv;
beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000);

const COLORS: Color[] = ["red", "green", "purple"];

describe("classifyColor", () => {
  for (const color of COLORS) {
    for (const fill of ["solid", "striped", "open"] as const) {
      test(`${color} ${fill}`, async () => {
        const card: Card = { count: 2, color, shape: "oval", fill };
        const raster = await renderCardRaster(card);
        const result = classifyColor(raster, segmentSymbols(cv, raster));
        expect(result.value).toBe(color);
        expect(result.confidence).toBeGreaterThan(0.3);
      });
    }
  }
});
