import sharp from "sharp";
import { beforeAll, describe, expect, test } from "vitest";
import { loadFixtures } from "../../../test/fixtures";
import { renderTableau } from "../../../test/synthetic/render";
import type { Card, Quad } from "../../model";
import { cardKey } from "../../model";
import { orderQuad } from "../quad";
import type { CardVision } from "../adapter";
import { createCardVision } from "../opencv";
import { loadOpenCv } from "../opencv/load-node";
import { readCard } from "./read-card";

async function downscale(image: ImageData, max: number): Promise<ImageData> {
  const factor = max / Math.max(image.width, image.height);
  const width = Math.round(image.width * factor);
  const height = Math.round(image.height * factor);
  const data = await sharp(Buffer.from(image.data.buffer), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer();
  return new ImageData(new Uint8ClampedArray(data), width, height);
}

function translate(quad: Quad, dx: number, dy: number): Quad {
  return quad.map((p) => ({ x: p.x + dx, y: p.y + dy })) as Quad;
}

let vision: CardVision;
beforeAll(async () => {
  vision = createCardVision(await loadOpenCv());
}, 30_000);

const CARD: Card = {
  count: 2,
  color: "red",
  shape: "oval",
  fill: "solid",
};

describe("readCard", () => {
  test("reads a single known card from its quad", async () => {
    const { image, truth } = await renderTableau([CARD]);
    const quad = orderQuad([...truth[0].quad]);

    const result = readCard(vision, image, quad);
    expect(result).not.toBeNull();
    expect(cardKey(result!.card)).toBe(cardKey(CARD));
  });

  test("returns null for a quad with no symbol regions", async () => {
    const { image } = await renderTableau([CARD]);
    // top-left corner of the tableau is empty background, well
    // outside the card's grid cell (see renderTableau's margins)
    const blankQuad: Quad = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
      { x: 0, y: 60 },
    ];

    const result = readCard(vision, image, blankQuad);
    expect(result).toBeNull();
  });

  // Regression (investigation: quad overshoot lets off-card content
  // past the border ring, where its area falls inside classifyCount's
  // AREA_CONSISTENCY band and gets counted as a symbol). A quad
  // shifted +8px in x on this fixture's "2-red-oval-open" card
  // systematically read count 3 instead of 2 before the ring-hugger
  // filter existed: the off-card strip is clipped flush on three
  // edges (dropped), while the two real ovals — merged with edge
  // bleed and clipped flush on ONE edge — must survive the filter.
  test("rejects ring-hugging intrusion after a quad overshoot", async () => {
    const fixtures = await loadFixtures("tuning");
    const fixture = fixtures.find((f) => f.name === "pic1326145");
    expect(fixture).toBeDefined();

    const factor = 768 / Math.max(fixture!.image.width, fixture!.image.height);
    const image = await downscale(fixture!.image, 768);
    const quads = vision.detectCards(image);

    const label = fixture!.cards.find((c) => c.key === "2-red-oval-open");
    expect(label).toBeDefined();
    const near = {
      x: label!.near.x * factor,
      y: label!.near.y * factor,
    };
    const matchRadius = Math.hypot(image.width, image.height) * 0.05;

    let best: Quad | undefined;
    let bestDistance = Infinity;
    for (const quad of quads) {
      const c = {
        x: (quad[0].x + quad[2].x) / 2,
        y: (quad[0].y + quad[2].y) / 2,
      };
      const d = Math.hypot(c.x - near.x, c.y - near.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = quad;
      }
    }
    expect(best).toBeDefined();
    expect(bestDistance).toBeLessThan(matchRadius);

    const shifted = translate(best!, 8, 0);
    const result = readCard(vision, image, shifted);
    expect(result).not.toBeNull();
    expect(result!.card.count).toBe(2);
  }, 30_000);
});
