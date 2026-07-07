import type { SymbolRegion } from "../../adapter";
import { BORDER_RING } from "../../adapter";
import { polygonBounds, polygonMask } from "../regions";

// Per-channel gains that would make the card's own border neutral.
// Every Set card carries this white reference; using it makes hue
// stable under warm/cool light (spec: white-balance before color).
export function whiteBalance(raster: ImageData): [number, number, number] {
  const { data, width, height } = raster;
  const rx = Math.max(2, Math.round(width * BORDER_RING));
  const ry = Math.max(2, Math.round(height * BORDER_RING));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < height; y++) {
    const inBorderRow = y < ry || y >= height - ry;
    for (let x = 0; x < width; x++) {
      if (!inBorderRow && x >= rx && x < width - rx) continue;
      const i = (y * width + x) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  r /= n;
  g /= n;
  b /= n;
  const luma = (r + g + b) / 3;
  return [luma / (r || 1), luma / (g || 1), luma / (b || 1)];
}

// A copy of the raster with border-ring white balance baked in. Under
// warm light the card FACE itself is saturated (measured HSV S of
// 60-90 on pic2934145 rasters), which swamps any absolute
// ink-saturation threshold downstream; balancing against the card's
// own white border restores "card face = neutral" for segmentation
// and classification alike.
export function whiteBalanced(raster: ImageData): ImageData {
  const gains = whiteBalance(raster);
  const data = new Uint8ClampedArray(raster.data.length);
  for (let i = 0; i < raster.data.length; i += 4) {
    data[i] = raster.data[i] * gains[0];
    data[i + 1] = raster.data[i + 1] * gains[1];
    data[i + 2] = raster.data[i + 2] * gains[2];
    data[i + 3] = raster.data[i + 3];
  }
  return new ImageData(data, raster.width, raster.height);
}

// Drop ring-hugging regions: off-card intrusion — table strip,
// background, shadow past the rectified border — let in by a quad
// that overshoots the true card edge (BORDER_RING, adapter.ts). Such
// a region's area can land inside classifyCount's AREA_CONSISTENCY
// band and get counted as a symbol (systematic count+1 that consensus
// locks onto). Filter once, here, before any classifier sees the
// regions — not a per-classifier band tweak.
export function withoutRingHuggers(
  regions: SymbolRegion[],
  raster: ImageData,
): SymbolRegion[] {
  const { width, height } = raster;
  const rx = Math.max(2, Math.round(width * BORDER_RING));
  const ry = Math.max(2, Math.round(height * BORDER_RING));
  // segmentSymbols blanks the ring with a corner-INCLUSIVE rectangle
  // (segment.ts), so the pixels surviving the blank span
  // [rx, width-1-rx] x [ry, height-1-ry] and anything clipped by the
  // blank sits flush ON those lines. Flush contact alone does not
  // separate intrusion from symbol — a real symbol on a dim,
  // imperfectly-quadded card can be clipped flush on one side
  // (pic1014255's third squiggle, maxX exactly on the last surviving
  // column, is a real symbol on a 55/55 fixture). What separates them
  // is HOW MANY sides: an off-card strip runs the full raster
  // dimension, so the blank clips it on three sides (the entering
  // edge plus both perpendicular edges), while a clipped symbol —
  // small relative to the card — touches exactly one. Hence: reject
  // flush contact on two or more edges; and reject outright any bbox
  // poking past the surviving rect (impossible after the blank, so
  // certainly off-card if a segmentation ever hands one over).
  const lastX = width - 1 - rx;
  const lastY = height - 1 - ry;
  return regions.filter((region) => {
    const b = polygonBounds(region.outline);
    if (b.minX < rx || b.maxX > lastX || b.minY < ry || b.maxY > lastY) {
      return false;
    }
    const flushEdges =
      Number(b.minX === rx) +
      Number(b.maxX === lastX) +
      Number(b.minY === ry) +
      Number(b.maxY === lastY);
    return flushEdges < 2;
  });
}

export function rgbAt(
  raster: ImageData,
  pixelIndex: number,
  gains: [number, number, number],
): [number, number, number] {
  const i = pixelIndex * 4;
  return [
    Math.min(255, raster.data[i] * gains[0]),
    Math.min(255, raster.data[i + 1] * gains[1]),
    Math.min(255, raster.data[i + 2] * gains[2]),
  ];
}

export function saturationOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

export function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  return (hue * 60 + 360) % 360;
}

// union mask of all symbol regions at raster resolution
export function regionMasks(
  raster: ImageData,
  regions: SymbolRegion[],
): Uint8Array {
  const union = new Uint8Array(raster.width * raster.height);
  for (const region of regions) {
    const mask = polygonMask(region.outline, raster.width, raster.height);
    for (let i = 0; i < union.length; i++) union[i] |= mask[i];
  }
  return union;
}
