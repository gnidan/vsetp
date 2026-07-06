import { describe, expect, test } from "vitest";
import { CARD_RASTER } from "../vision/adapter";
import { cardFaceDataUrl, cardFaceSvg } from "./card-face";

describe("cardFaceSvg", () => {
  test("renders count symbols with the card's ink", () => {
    const svg = cardFaceSvg(
      { count: 3, color: "purple", shape: "diamond", fill: "open" },
      CARD_RASTER.height,
    );
    expect(svg.match(/<path/g)).toHaveLength(3);
    expect(svg).toContain("#6a2c91");
  });
});

describe("cardFaceDataUrl", () => {
  test("is a decodable standalone SVG document at raster size", () => {
    const url = cardFaceDataUrl({
      count: 1,
      color: "red",
      shape: "squiggle",
      fill: "striped",
    });
    expect(url.startsWith("data:image/svg+xml,")).toBe(true);
    const svg = decodeURIComponent(url.slice("data:image/svg+xml,".length));
    expect(svg).toContain(`width="${CARD_RASTER.width}"`);
    expect(svg).toContain("</svg>");
  });
});
