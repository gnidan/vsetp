import { describe, expect, test } from "vitest";
import { CARD_RASTER } from "../../src/vision/adapter";
import { renderCardRaster, renderTableau } from "./render";

function pixelAt(image: ImageData, x: number, y: number) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

describe("renderCardRaster", () => {
  test("renders at CARD_RASTER size with white border", async () => {
    const image = await renderCardRaster({
      count: 1,
      color: "red",
      shape: "oval",
      fill: "solid",
    });
    expect(image.width).toBe(CARD_RASTER.width);
    expect(image.height).toBe(CARD_RASTER.height);
    const [r, g, b] = pixelAt(image, 5, 5); // border is card-white
    expect(r).toBeGreaterThan(230);
    expect(g).toBeGreaterThan(230);
    expect(b).toBeGreaterThan(230);
  });

  test("solid red card has red center pixel", async () => {
    const image = await renderCardRaster({
      count: 1,
      color: "red",
      shape: "oval",
      fill: "solid",
    });
    const [r, g, b] = pixelAt(image, image.width / 2, image.height / 2);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(120);
    expect(b).toBeLessThan(120);
  });

  test("open card has white center pixel", async () => {
    const image = await renderCardRaster({
      count: 1,
      color: "red",
      shape: "oval",
      fill: "open",
    });
    const [r, g, b] = pixelAt(image, image.width / 2, image.height / 2);
    expect(r).toBeGreaterThan(230);
    expect(g).toBeGreaterThan(230);
    expect(b).toBeGreaterThan(230);
  });
});

describe("renderTableau", () => {
  test("renders cards with in-bounds ground-truth quads", async () => {
    const cards = [
      { count: 1, color: "red", shape: "oval", fill: "solid" },
      { count: 2, color: "green", shape: "diamond", fill: "striped" },
      { count: 3, color: "purple", shape: "squiggle", fill: "open" },
    ] as const;
    const { image, truth } = await renderTableau([...cards]);
    expect(image.width).toBe(1600);
    expect(truth).toHaveLength(3);
    for (const { quad } of truth) {
      for (const p of quad) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(image.width);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(image.height);
      }
    }
  });

  test("truth quads match the rendered card boxes", async () => {
    const { image, truth } = await renderTableau(
      [{ count: 1, color: "red", shape: "oval", fill: "solid" }],
      { rotate: false },
    );
    const [{ quad }] = truth;
    const cx = (quad[0].x + quad[2].x) / 2;
    const midTopIn = { x: cx, y: quad[0].y + 4 };
    const midTopOut = { x: cx, y: quad[0].y - 4 };
    const inside = pixelAt(
      image,
      Math.round(midTopIn.x),
      Math.round(midTopIn.y),
    );
    const outside = pixelAt(
      image,
      Math.round(midTopOut.x),
      Math.round(midTopOut.y),
    );
    expect(Math.min(...inside)).toBeGreaterThan(200); // card-white
    expect(outside[0]).toBeLessThan(120); // felt background
  });
});
