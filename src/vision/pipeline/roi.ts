import type { Point, Quad } from "../../model";
import type { CardVision } from "../adapter";

export const ROI_SPAN_FACTOR = 0.35; // of frame long edge

// Pure RGBA sub-rect copy, clamped to bounds. No OpenCV.
export function cropAround(
  frame: ImageData,
  at: Point,
  span: number,
): { image: ImageData; offset: Point } {
  // floor to integer pixels: callers pass fractional spans (e.g.
  // ROI_SPAN_FACTOR * longEdge = 268.8 on a 768px live frame), and a
  // fractional side corrupts every buffer offset derived from it
  const side = Math.floor(Math.min(span, frame.width, frame.height));
  const x0 = Math.round(
    Math.min(Math.max(at.x - side / 2, 0), frame.width - side),
  );
  const y0 = Math.round(
    Math.min(Math.max(at.y - side / 2, 0), frame.height - side),
  );
  const out = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    const src = ((y0 + y) * frame.width + x0) * 4;
    out.set(frame.data.subarray(src, src + side * 4), y * side * 4);
  }
  return { image: new ImageData(out, side, side), offset: { x: x0, y: y0 } };
}

// The missed-card assist: the user asserted a card exists here, so
// detection runs on the full-resolution crop with relaxed gates
// (spec: acceptable false-positive risk; consensus still applies).
export function detectCardsInRoi(
  vision: CardVision,
  frame: ImageData,
  at: Point,
): Quad[] {
  const span = ROI_SPAN_FACTOR * Math.max(frame.width, frame.height);
  const { image, offset } = cropAround(frame, at, span);
  const quads = vision.detectCards(image, {
    maxDimension: Math.max(image.width, image.height),
    relaxed: true,
  });
  return quads.map(
    (quad) =>
      quad.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })) as Quad,
  );
}
