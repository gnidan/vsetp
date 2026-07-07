import type { Point, Quad } from "../model";

// row-major 3x3
export type Homography = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

// unit square (0,0)-(1,1) onto quad, corners TL,TR,BR,BL —
// Heckbert's closed-form projective mapping
function unitSquareToQuad(quad: Quad): Homography {
  const [p0, p1, p2, p3] = quad;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    // affine
    return [
      p1.x - p0.x,
      p3.x - p0.x,
      p0.x,
      p1.y - p0.y,
      p3.y - p0.y,
      p0.y,
      0,
      0,
      1,
    ];
  }
  const dx1 = p1.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dx2 = p3.x - p2.x;
  const dy2 = p3.y - p2.y;
  const denominator = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denominator) < 1e-9) {
    // p1, p2, p3 collinear: no valid homography exists; fall back to
    // the affine mapping rather than emitting NaN into matrix3d
    return [
      p1.x - p0.x,
      p3.x - p0.x,
      p0.x,
      p1.y - p0.y,
      p3.y - p0.y,
      p0.y,
      0,
      0,
      1,
    ];
  }
  const g = (sx * dy2 - sy * dx2) / denominator;
  const h = (dx1 * sy - dy1 * sx) / denominator;
  return [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
    1,
  ];
}

export function rectToQuad(
  width: number,
  height: number,
  quad: Quad,
): Homography {
  const h = unitSquareToQuad(quad);
  // compose with scale(1/width, 1/height): divide the first two
  // columns
  return [
    h[0] / width,
    h[1] / height,
    h[2],
    h[3] / width,
    h[4] / height,
    h[5],
    h[6] / width,
    h[7] / height,
    h[8],
  ];
}

export function applyHomography(h: Homography, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

// CSS matrix3d is column-major 4x4; embed the 3x3 with z passthrough
export function toMatrix3d(h: Homography): string {
  const m = [
    h[0],
    h[3],
    0,
    h[6],
    h[1],
    h[4],
    0,
    h[7],
    0,
    0,
    1,
    0,
    h[2],
    h[5],
    0,
    h[8],
  ];
  return `matrix3d(${m.join(",")})`;
}

// object-fit: cover — the live viewfinder's mapping. The provider
// video fills the stage with cover (cropping the overflow axis), so
// live-frame coordinates must scale by the LARGER ratio and center
// with negative offsets on the cropped axis to stay glued to the
// visible pixels. (The frame and the video share an aspect ratio by
// construction: live capture clamps the video's own dimensions.)
export function coverTransform(
  frame: { width: number; height: number },
  container: { width: number; height: number },
): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.max(
    container.width / frame.width,
    container.height / frame.height,
  );
  return {
    scale,
    offsetX: (container.width - frame.width * scale) / 2,
    offsetY: (container.height - frame.height * scale) / 2,
  };
}

// object-fit: contain — the spec's ViewportTransform
export function displayTransform(
  frame: { width: number; height: number },
  container: { width: number; height: number },
): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.min(
    container.width / frame.width,
    container.height / frame.height,
  );
  return {
    scale,
    offsetX: (container.width - frame.width * scale) / 2,
    offsetY: (container.height - frame.height * scale) / 2,
  };
}
