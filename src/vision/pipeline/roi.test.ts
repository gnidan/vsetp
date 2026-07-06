import { beforeAll, describe, expect, it } from "vitest";
import type { CardVision } from "../adapter";
import { createCardVision } from "../opencv";
import { loadOpenCv } from "../opencv/load-node";
import { loadFixtures } from "../../../test/fixtures";
import { cropAround, detectCardsInRoi, ROI_SPAN_FACTOR } from "./roi";

function checkerFrame(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = x === 100 && y === 50 ? 255 : 0; // one white pixel
      data[i] = v;
      data[i + 3] = 255;
    }
  return new ImageData(data, width, height);
}

describe("cropAround", () => {
  it("copies the sub-rect and reports its offset", () => {
    const frame = checkerFrame(200, 100);
    const { image, offset } = cropAround(frame, { x: 100, y: 50 }, 40);
    expect(image.width).toBe(40);
    expect(image.height).toBe(40);
    const local = ((50 - offset.y) * 40 + (100 - offset.x)) * 4;
    expect(image.data[local]).toBe(255); // the white pixel came along
  });

  it("clamps at frame edges", () => {
    const frame = checkerFrame(200, 100);
    const { image, offset } = cropAround(frame, { x: 5, y: 5 }, 40);
    expect(offset).toEqual({ x: 0, y: 0 });
    expect(image.width).toBe(40);
  });

  it("exports the spec span factor", () => {
    expect(ROI_SPAN_FACTOR).toBe(0.35);
  });

  // detectCardsInRoi passes span = 0.35 * longEdge, which is
  // fractional for most frame sizes; cropAround must floor to
  // integer pixel dimensions or the row-copy offsets accumulate
  // truncation error into a RangeError.
  it("handles a fractional span (live 768x576 frame)", () => {
    const frame = checkerFrame(768, 576);
    const span = ROI_SPAN_FACTOR * 768; // 268.8
    const { image, offset } = cropAround(frame, { x: 384, y: 288 }, span);
    expect(image.width).toBe(268);
    expect(image.height).toBe(268);
    expect(Number.isInteger(offset.x)).toBe(true);
    expect(Number.isInteger(offset.y)).toBe(true);
    expect(offset.x).toBeGreaterThanOrEqual(0);
    expect(offset.y).toBeGreaterThanOrEqual(0);
    expect(offset.x + image.width).toBeLessThanOrEqual(768);
    expect(offset.y + image.height).toBeLessThanOrEqual(576);
  });

  it("handles a fractional span (3072x2304 normalized still)", () => {
    const frame = checkerFrame(3072, 2304);
    const span = ROI_SPAN_FACTOR * 3072; // 1075.2
    const { image, offset } = cropAround(
      frame,
      { x: 3000, y: 2200 }, // near the corner: clamp path too
      span,
    );
    expect(image.width).toBe(1075);
    expect(image.height).toBe(1075);
    expect(offset.x + image.width).toBeLessThanOrEqual(3072);
    expect(offset.y + image.height).toBeLessThanOrEqual(2304);
  });
});

// max label-to-detection distance as a fraction of the image diagonal;
// mirrors test/real-photos.test.ts's MATCH_RADIUS_FRACTION.
const MATCH_RADIUS_FRACTION = 0.05;

describe("detectCardsInRoi (real photo)", () => {
  let vision: CardVision;
  beforeAll(async () => {
    vision = createCardVision(await loadOpenCv());
  }, 30_000);

  it("finds the labeled card the user tapped on", async () => {
    const [fixture] = (await loadFixtures("tuning")).filter(
      (f) => f.name === "pic1326145",
    );
    expect(fixture).toBeDefined();
    const label = fixture.cards.find((c) => c.key === "1-green-squiggle-solid");
    expect(label).toBeDefined();
    if (!label) return;

    const quads = detectCardsInRoi(vision, fixture.image, label.near);
    const matchRadius =
      Math.hypot(fixture.image.width, fixture.image.height) *
      MATCH_RADIUS_FRACTION;
    const centroids = quads.map((quad) => ({
      x: quad.reduce((s, p) => s + p.x, 0) / 4,
      y: quad.reduce((s, p) => s + p.y, 0) / 4,
    }));
    const nearestDistance = Math.min(
      ...centroids.map((c) =>
        Math.hypot(c.x - label.near.x, c.y - label.near.y),
      ),
    );
    expect(quads.length).toBeGreaterThan(0);
    expect(nearestDistance).toBeLessThan(matchRadius);
  }, 30_000);
});
