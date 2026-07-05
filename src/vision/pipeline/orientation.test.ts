import { beforeAll, describe, expect, test } from "vitest";
import { renderCardRaster } from "../../../test/synthetic/render";
import type { Quad } from "../../model";
import type { CardVision, SymbolRegion } from "../adapter";
import { createCardVision } from "../opencv";
import { loadOpenCv } from "../opencv/load-node";
import { isSideways, orientQuad } from "./orientation";

// axis-aligned rectangular region centered at (cx, cy)
function rectRegion(
  cx: number,
  cy: number,
  width: number,
  height: number,
): SymbolRegion {
  const outline = [
    { x: cx - width / 2, y: cy - height / 2 },
    { x: cx + width / 2, y: cy - height / 2 },
    { x: cx + width / 2, y: cy + height / 2 },
    { x: cx - width / 2, y: cy + height / 2 },
  ];
  return { outline, hull: outline };
}

// canonical rectified raster dimensions (CARD_RASTER)
const RASTER = { width: 600, height: 384 };

describe("isSideways", () => {
  test("two centroids spread along x (canonical) is not sideways", () => {
    const regions = [
      rectRegion(228, 192, 120, 240),
      rectRegion(372, 192, 120, 240),
    ];
    expect(isSideways(regions, RASTER)).toBe(false);
  });

  test("two centroids spread along y is sideways", () => {
    // a foreshortened card rectified short-edge-up: the symbol row
    // runs down the raster instead of across it
    const regions = [
      rectRegion(300, 120, 240, 80),
      rectRegion(300, 264, 240, 80),
    ];
    expect(isSideways(regions, RASTER)).toBe(true);
  });

  test("three centroids spread along x is not sideways", () => {
    const regions = [
      rectRegion(156, 192, 120, 240),
      rectRegion(300, 192, 120, 240),
      rectRegion(444, 192, 120, 240),
    ];
    expect(isSideways(regions, RASTER)).toBe(false);
  });

  test("single taller-than-wide symbol (canonical) is not sideways", () => {
    expect(isSideways([rectRegion(300, 192, 120, 240)], RASTER)).toBe(false);
  });

  test("single clearly-horizontal symbol is sideways", () => {
    // what rectify produces for a sideways card: the symbol's long
    // axis stretched across the raster width (measured ~385x83)
    expect(isSideways([rectRegion(300, 192, 375, 77)], RASTER)).toBe(true);
  });

  test("single clearly-horizontal oval outline is sideways", () => {
    // sampled ellipse, not just a bbox: principal axis horizontal
    const outline = Array.from({ length: 24 }, (_, i) => {
      const a = (2 * Math.PI * i) / 24;
      return { x: 300 + 190 * Math.cos(a), y: 192 + 45 * Math.sin(a) };
    });
    expect(isSideways([{ outline, hull: outline }], RASTER)).toBe(true);
  });

  test("near-isotropic single region at mild skew does not flip", () => {
    // a blurred squiggle can segment blob-like; under perspective
    // skew its bbox can tip wider-than-tall (250x135 here — the old
    // bbox-aspect rule flipped this), but its principal axis is too
    // close to isotropic to trust — keep the geometric order
    const c = { x: 300, y: 192 };
    const rad = (8 * Math.PI) / 180;
    const outline = [
      { x: -125, y: -67.5 },
      { x: 125, y: -67.5 },
      { x: 125, y: 67.5 },
      { x: -125, y: 67.5 },
    ].map((p) => ({
      x: c.x + p.x * Math.cos(rad) - p.y * Math.sin(rad),
      y: c.y + p.x * Math.sin(rad) + p.y * Math.cos(rad),
    }));
    expect(isSideways([{ outline, hull: outline }], RASTER)).toBe(false);
  });

  test("debris does not pollute the row-axis vote", () => {
    // pic2934145's 1-green-squiggle-open: a thin horizontal sliver
    // (broken pale stroke) plus the real upright symbol used to read
    // as a 2-region row spread along y and flip the card. The sliver
    // fails the same area-consistency band classifyCount uses, so
    // orientation must ignore it and read the symbol alone.
    const regions = [
      rectRegion(300, 350, 333, 20),
      rectRegion(300, 190, 130, 260),
    ];
    expect(isSideways(regions, RASTER)).toBe(false);
  });

  test("no regions is not sideways", () => {
    expect(isSideways([], RASTER)).toBe(false);
  });
});

describe("orientQuad", () => {
  const quad: Quad = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 60 },
    { x: 0, y: 60 },
  ];

  test("returns the quad unchanged when content is upright", () => {
    const regions = [rectRegion(300, 192, 120, 240)];
    expect(orientQuad(quad, regions, RASTER)).toBe(quad);
  });

  test("rotates corner order by one position when sideways", () => {
    const regions = [rectRegion(300, 192, 375, 77)];
    expect(orientQuad(quad, regions, RASTER)).toEqual([
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
      { x: 0, y: 0 },
    ]);
  });
});

// rotate an RGBA image 90 degrees clockwise
function rotate90(image: ImageData): ImageData {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = (x * height + (height - 1 - y)) * 4;
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = data[src + 3];
    }
  }
  return new ImageData(out, height, width);
}

describe("isSideways on segmented rasters", () => {
  let vision: CardVision;
  beforeAll(async () => {
    vision = createCardVision(await loadOpenCv());
  }, 30_000);

  test("a rendered card raster is upright; rotated 90deg it is sideways", async () => {
    const raster = await renderCardRaster({
      count: 2,
      color: "purple",
      shape: "diamond",
      fill: "solid",
    });
    const upright = vision.segmentSymbols(raster);
    expect(upright.length).toBe(2);
    expect(isSideways(upright, raster)).toBe(false);

    const rotated = rotate90(raster);
    const sideways = vision.segmentSymbols(rotated);
    expect(sideways.length).toBe(2);
    expect(isSideways(sideways, rotated)).toBe(true);
  });

  test("detects a sideways single-symbol raster from bbox aspect", async () => {
    const raster = await renderCardRaster({
      count: 1,
      color: "green",
      shape: "oval",
      fill: "solid",
    });
    const rotated = rotate90(raster);
    const regions = vision.segmentSymbols(rotated);
    expect(regions.length).toBe(1);
    expect(isSideways(regions, rotated)).toBe(true);
  });
});
