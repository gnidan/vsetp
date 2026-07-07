import { describe, expect, test } from "vitest";
import type { Quad } from "../model";
import {
  applyHomography,
  coverTransform,
  displayTransform,
  rectToQuad,
  toMatrix3d,
} from "./homography";

function expectClose(a: { x: number; y: number }, b: { x: number; y: number }) {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
}

describe("rectToQuad", () => {
  test("identity when the quad is the rect itself", () => {
    const quad: Quad = [
      { x: 0, y: 0 },
      { x: 600, y: 0 },
      { x: 600, y: 384 },
      { x: 0, y: 384 },
    ];
    const h = rectToQuad(600, 384, quad);
    expectClose(applyHomography(h, { x: 300, y: 192 }), { x: 300, y: 192 });
  });

  test("maps all four rect corners onto the quad corners", () => {
    const quad: Quad = [
      { x: 120, y: 80 },
      { x: 520, y: 60 },
      { x: 560, y: 300 },
      { x: 100, y: 340 },
    ];
    const h = rectToQuad(600, 384, quad);
    expectClose(applyHomography(h, { x: 0, y: 0 }), quad[0]);
    expectClose(applyHomography(h, { x: 600, y: 0 }), quad[1]);
    expectClose(applyHomography(h, { x: 600, y: 384 }), quad[2]);
    expectClose(applyHomography(h, { x: 0, y: 384 }), quad[3]);
  });

  test("perspective (non-affine) quads work: midpoints do not map affinely", () => {
    // trapezoid: pure affine cannot map a rect onto it
    const quad: Quad = [
      { x: 200, y: 100 },
      { x: 400, y: 100 },
      { x: 500, y: 300 },
      { x: 100, y: 300 },
    ];
    const h = rectToQuad(600, 384, quad);
    const center = applyHomography(h, { x: 300, y: 192 });
    // the projective center is NOT the affine average (300, 200);
    // the perspective divide compresses point density near the
    // narrow (top) edge, so the parametric midpoint is pulled
    // toward the narrower edge, not the wider one
    expect(center.y).toBeLessThan(200);
  });

  test("degenerate quads yield finite (affine) homographies", () => {
    // p1, p2, p3 collinear: the projective branch's denominator is
    // zero and no true homography exists; the code must fall back to
    // an affine mapping instead of emitting NaN/Infinity.
    const collinear: Quad = [
      { x: 0, y: 100 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
    ];
    const h = rectToQuad(600, 384, collinear);
    for (const value of h) expect(Number.isFinite(value)).toBe(true);
  });
});

describe("toMatrix3d", () => {
  test("identity homography yields the identity matrix3d", () => {
    expect(toMatrix3d([1, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(
      "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)",
    );
  });
});

describe("displayTransform", () => {
  test("contain-fits landscape into landscape container", () => {
    const t = displayTransform(
      { width: 3072, height: 2304 },
      { width: 768, height: 768 },
    );
    expect(t.scale).toBeCloseTo(0.25);
    expect(t.offsetX).toBe(0);
    expect(t.offsetY).toBeCloseTo((768 - 576) / 2);
  });
});

describe("coverTransform", () => {
  test("cover-fills: scales to the LARGER ratio and centers", () => {
    // landscape frame in a square container: height is the binding
    // axis under cover; the width overflows and centers (crops)
    const t = coverTransform(
      { width: 768, height: 576 },
      { width: 768, height: 768 },
    );
    expect(t.scale).toBeCloseTo(768 / 576);
    expect(t.offsetY).toBe(0);
    expect(t.offsetX).toBeCloseTo((768 - 768 * (768 / 576)) / 2);
    expect(t.offsetX).toBeLessThan(0);
  });

  test("matches displayTransform when aspect ratios agree", () => {
    const frame = { width: 768, height: 432 };
    const container = { width: 384, height: 216 };
    expect(coverTransform(frame, container)).toEqual(
      displayTransform(frame, container),
    );
  });
});
