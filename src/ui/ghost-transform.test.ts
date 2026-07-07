import { describe, expect, test } from "vitest";
import type { Quad } from "../model";
import { CARD_RASTER } from "../vision/adapter";
import { rectToQuad, toMatrix3d } from "./homography";
import { ghostTransform, quadPoints } from "./ghost-transform";

const QUAD: Quad = [
  { x: 120, y: 80 },
  { x: 520, y: 60 },
  { x: 560, y: 300 },
  { x: 100, y: 340 },
];

describe("ghostTransform", () => {
  test("is the CARD_RASTER rect-to-quad homography as matrix3d", () => {
    expect(ghostTransform(QUAD)).toBe(
      toMatrix3d(rectToQuad(CARD_RASTER.width, CARD_RASTER.height, QUAD)),
    );
  });
});

describe("quadPoints", () => {
  test("joins corners into an SVG points string", () => {
    expect(quadPoints(QUAD)).toBe("120,80 520,60 560,300 100,340");
  });
});
