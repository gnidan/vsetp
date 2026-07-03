import { describe, expect, test } from "vitest";
import type { Point } from "../model";
import { orderQuad } from "./quad";

function edgeLength(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

describe("orderQuad", () => {
  test("longest edge comes first regardless of input order", () => {
    // landscape 200x100 rectangle, corners shuffled
    const shuffled: Point[] = [
      { x: 200, y: 100 },
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 0, y: 100 },
    ];
    const q = orderQuad(shuffled);
    expect(edgeLength(q[0], q[1])).toBeCloseTo(200);
  });

  test("orders a rotated rectangle consistently", () => {
    // 200x100 rectangle rotated 30 degrees about its center
    const c = { x: 100, y: 50 };
    const rot = (p: Point): Point => {
      const rad = (30 * Math.PI) / 180;
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      return {
        x: c.x + dx * Math.cos(rad) - dy * Math.sin(rad),
        y: c.y + dx * Math.sin(rad) + dy * Math.cos(rad),
      };
    };
    const corners: Point[] = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ].map(rot);
    const q = orderQuad([corners[2], corners[0], corners[3], corners[1]]);
    // first edge is one of the two long edges
    expect(edgeLength(q[0], q[1])).toBeCloseTo(200, 0);
    // consecutive corners are adjacent (perimeter order, no diagonals)
    expect(edgeLength(q[1], q[2])).toBeCloseTo(100, 0);
    expect(edgeLength(q[2], q[3])).toBeCloseTo(200, 0);
  });

  test("throws unless given exactly 4 points", () => {
    expect(() => orderQuad([{ x: 0, y: 0 }])).toThrow();
  });
});
