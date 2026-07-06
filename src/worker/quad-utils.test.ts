import { describe, expect, it } from "vitest";
import type { Quad } from "../model";
import { aabbIou, centroid, distance, quadArea } from "./quad-utils";

const rect = (x: number, y: number, w: number, h: number): Quad => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

describe("quad-utils", () => {
  it("centroid averages corners", () => {
    expect(centroid(rect(0, 0, 10, 20))).toEqual({ x: 5, y: 10 });
  });

  it("shoelace area of an axis-aligned rect", () => {
    expect(quadArea(rect(2, 3, 10, 20))).toBe(200);
  });

  it("aabbIou of identical quads is 1", () => {
    expect(aabbIou(rect(0, 0, 10, 10), rect(0, 0, 10, 10))).toBe(1);
  });

  it("aabbIou of half-overlapping quads", () => {
    // overlap 5x10 = 50; union 100+100-50 = 150
    expect(aabbIou(rect(0, 0, 10, 10), rect(5, 0, 10, 10))).toBeCloseTo(
      50 / 150,
    );
  });

  it("aabbIou of disjoint quads is 0", () => {
    expect(aabbIou(rect(0, 0, 10, 10), rect(30, 30, 5, 5))).toBe(0);
  });

  it("distance", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});
