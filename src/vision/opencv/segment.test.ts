import { beforeAll, describe, expect, test } from "vitest";
import { renderCardRaster } from "../../../test/synthetic/render";
import type { Card, Count, Fill, Shape } from "../../model";
import type { Cv } from "./cv";
import { loadOpenCv } from "./load-node";
import { segmentSymbols } from "./segment";

let cv: Cv;
beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000);

const SHAPES: Shape[] = ["diamond", "oval", "squiggle"];
const FILLS: Fill[] = ["solid", "striped", "open"];
const COUNTS: Count[] = [1, 2, 3];

describe("segmentSymbols is fill-invariant", () => {
  for (const shape of SHAPES) {
    for (const fill of FILLS) {
      for (const count of COUNTS) {
        test(`${count} ${fill} ${shape} -> ${count} region(s)`, async () => {
          const card: Card = { count, color: "purple", shape, fill };
          const raster = await renderCardRaster(card);
          const regions = segmentSymbols(cv, raster);
          expect(regions).toHaveLength(count);
          for (const region of regions) {
            expect(region.outline.length).toBeGreaterThan(7);
            expect(region.hull.length).toBeGreaterThanOrEqual(3);
          }
        });
      }
    }
  }
});
