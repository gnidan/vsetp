import type { Point } from "../../model";

export function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function perimeter(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

function pointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq))
    : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function douglasPeucker(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;
  const a = points[0];
  const b = points[points.length - 1];
  let maxDistance = -1;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToSegment(points[i], a, b);
    if (d > maxDistance) {
      maxDistance = d;
      index = i;
    }
  }
  if (maxDistance <= epsilon) return [a, b];
  const left = douglasPeucker(points.slice(0, index + 1), epsilon);
  const right = douglasPeucker(points.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

// closed-polygon Douglas-Peucker: anchor at the two mutually farthest
// points, simplify each chain, and rejoin
export function simplifyPolygon(points: Point[], epsilon: number): Point[] {
  if (points.length <= 4) return points;
  let ai = 0;
  let bi = 1;
  let far = -1;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(
        points[j].x - points[i].x,
        points[j].y - points[i].y,
      );
      if (d > far) {
        far = d;
        ai = i;
        bi = j;
      }
    }
  }
  const chain1 = points.slice(ai, bi + 1);
  const chain2 = [...points.slice(bi), ...points.slice(0, ai + 1)];
  const s1 = douglasPeucker(chain1, epsilon);
  const s2 = douglasPeucker(chain2, epsilon);
  return [...s1.slice(0, -1), ...s2.slice(0, -1)];
}

export function maxHullDeviation(outline: Point[], hull: Point[]): number {
  let max = 0;
  for (const p of outline) {
    let nearest = Infinity;
    for (let i = 0; i < hull.length; i++) {
      nearest = Math.min(
        nearest,
        pointToSegment(p, hull[i], hull[(i + 1) % hull.length]),
      );
    }
    max = Math.max(max, nearest);
  }
  return max;
}

export function polygonMask(
  outline: Point[],
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const xs: number[] = [];
    const scanY = y + 0.5;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      if (a.y <= scanY === b.y <= scanY) continue;
      xs.push(a.x + ((scanY - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = from; x <= to; x++) mask[y * width + x] = 1;
    }
  }
  return mask;
}

export function erodeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  iterations: number,
): Uint8Array {
  let current = mask;
  for (let n = 0; n < iterations; n++) {
    const next = new Uint8Array(width * height);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        next[i] =
          current[i] &
          current[i - 1] &
          current[i + 1] &
          current[i - width] &
          current[i + width];
      }
    }
    current = next;
  }
  return current;
}
