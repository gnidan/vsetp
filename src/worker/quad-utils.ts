import type { Point, Quad } from "../model";

export function centroid(quad: Quad): Point {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}

export function quadArea(quad: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

interface Aabb {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function aabb(quad: Quad): Aabb {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

// AABB approximation of IoU. Cards are near-axis-aligned rectangles
// at matching timescales (the camera moves smoothly between frames),
// so box overlap is selective enough for assignment; exact polygon
// intersection is not worth its cost here.
export function aabbIou(a: Quad, b: Quad): number {
  const ba = aabb(a);
  const bb = aabb(b);
  const ix = Math.max(0, Math.min(ba.x1, bb.x1) - Math.max(ba.x0, bb.x0));
  const iy = Math.max(0, Math.min(ba.y1, bb.y1) - Math.max(ba.y0, bb.y0));
  const inter = ix * iy;
  const areaA = (ba.x1 - ba.x0) * (ba.y1 - ba.y0);
  const areaB = (bb.x1 - bb.x0) * (bb.y1 - bb.y0);
  const union = areaA + areaB - inter;
  return union === 0 ? 0 : inter / union;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
