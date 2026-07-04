import { beforeAll, describe, expect, test } from "vitest";
import { renderTableau } from "../../../test/synthetic/render";
import type { Card } from "../../model";
import { CARD_RASTER } from "../adapter";
import { orderQuad } from "../quad";
import type { Cv } from "./cv";
import { loadOpenCv } from "./load-node";
import { rectifyCard } from "./rectify";

let cv: Cv;
beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000);

const CARD: Card = {
  count: 1,
  color: "red",
  shape: "oval",
  fill: "solid",
};

describe("rectifyCard", () => {
  test("produces a CARD_RASTER-sized card with centered ink", async () => {
    const { image, truth } = await renderTableau([CARD]);
    const raster = rectifyCard(cv, image, orderQuad([...truth[0].quad]));
    expect(raster.width).toBe(CARD_RASTER.width);
    expect(raster.height).toBe(CARD_RASTER.height);

    const at = (x: number, y: number) => {
      const i = (y * raster.width + x) * 4;
      return [raster.data[i], raster.data[i + 1], raster.data[i + 2]];
    };
    // corners: card-white
    const [r0, g0, b0] = at(20, 20);
    expect(Math.min(r0, g0, b0)).toBeGreaterThan(200);
    // center: red ink (solid oval)
    const [r1, g1] = at(raster.width / 2, raster.height / 2);
    expect(r1).toBeGreaterThan(140);
    expect(g1).toBeLessThan(130);
  });
});
