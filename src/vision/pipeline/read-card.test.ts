import { beforeAll, describe, expect, test } from "vitest";
import { renderTableau } from "../../../test/synthetic/render";
import type { Card, Quad } from "../../model";
import { cardKey } from "../../model";
import { orderQuad } from "../quad";
import type { CardVision } from "../adapter";
import { createCardVision } from "../opencv";
import { loadOpenCv } from "../opencv/load-node";
import { readCard } from "./read-card";

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
});
