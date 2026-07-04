import { describe, expect, test } from "vitest";
import type { Point } from "../../model";
import {
  erodeMask,
  maxHullDeviation,
  perimeter,
  polygonArea,
  polygonMask,
  simplifyPolygon,
} from "./regions";

const square: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe("polygonArea / perimeter", () => {
  test("square", () => {
    expect(polygonArea(square)).toBe(100);
    expect(perimeter(square)).toBe(40);
  });
  test("orientation-independent", () => {
    expect(polygonArea([...square].reverse())).toBe(100);
  });
});

describe("simplifyPolygon", () => {
  test("collapses collinear points on a square boundary", () => {
    const dense: Point[] = [];
    for (let i = 0; i <= 10; i++) dense.push({ x: i, y: 0 });
    for (let i = 1; i <= 10; i++) dense.push({ x: 10, y: i });
    for (let i = 9; i >= 0; i--) dense.push({ x: i, y: 10 });
    for (let i = 9; i >= 1; i--) dense.push({ x: 0, y: i });
    expect(simplifyPolygon(dense, 0.5)).toHaveLength(4);
  });
});

describe("maxHullDeviation", () => {
  test("zero for a convex polygon", () => {
    expect(maxHullDeviation(square, square)).toBeCloseTo(0);
  });
  test("measures a notch depth", () => {
    // square with a notch reaching the center
    const notched: Point[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 5, y: 5 }, // notch tip, 5 below the top edge
      { x: 6, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(maxHullDeviation(notched, square)).toBeCloseTo(5);
  });
});

describe("polygonMask / erodeMask", () => {
  test("fills the interior, erosion shrinks it", () => {
    const mask = polygonMask(square, 12, 12);
    const count = mask.reduce((s: number, v) => s + v, 0);
    // center-sampling: pixel (x,y) filled iff center (x+.5,y+.5)
    // is inside the polygon — exactly 0..9 x 0..9 for this square
    expect(count).toBe(100);
    expect(mask[6 * 12 + 5]).toBe(1); // center inside
    expect(mask[0]).toBe(1); // (0,0): center (0.5,0.5) inside
    expect(mask[10 * 12 + 10]).toBe(0); // (10,10): center outside
    const eroded = erodeMask(mask, 12, 12, 2);
    const erodedCount = eroded.reduce((s: number, v) => s + v, 0);
    expect(erodedCount).toBeLessThan(count);
    expect(eroded[6 * 12 + 5]).toBe(1); // center survives
  });
});
