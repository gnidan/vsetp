import { beforeAll, describe, expect, test } from "vitest";
import { renderCardRaster } from "../../../../test/synthetic/render";
import type { Card, Count, Fill } from "../../../model";
import type { Cv } from "../../opencv/cv";
import { loadOpenCv } from "../../opencv/load-node";
import { segmentSymbols } from "../../opencv/segment";
import { classifyCount } from "./count";

let cv: Cv;
beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000);

describe("classifyCount", () => {
  for (const count of [1, 2, 3] as Count[]) {
    for (const fill of ["solid", "striped", "open"] as Fill[]) {
      test(`${count} ${fill} symbols`, async () => {
        const card: Card = { count, color: "green", shape: "diamond", fill };
        const raster = await renderCardRaster(card);
        const result = classifyCount(segmentSymbols(cv, raster));
        expect(result.value).toBe(count);
        expect(result.confidence).toBeGreaterThan(0.5);
      });
    }
  }

  test("degrades confidence gracefully outside 1..3", () => {
    const result = classifyCount([]);
    expect(result.value).toBe(1);
    expect(result.confidence).toBe(0);
  });
});
