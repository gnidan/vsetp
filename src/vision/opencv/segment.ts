import type { SymbolRegion } from "../adapter";
import type { Cv } from "./cv";

// a symbol must occupy a sane fraction of the raster
const MIN_SYMBOL_AREA_FRACTION = 0.01;
const MAX_SYMBOL_AREA_FRACTION = 0.35;

// ink = notably saturated OR notably dark (catches all three colors
// on the white card face)
const MIN_INK_SATURATION = 60; // 0..255
const MAX_INK_VALUE = 140; // 0..255

function matToPoints(mat: Cv): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < mat.rows; i++) {
    points.push({ x: mat.data32S[i * 2], y: mat.data32S[i * 2 + 1] });
  }
  return points;
}

export function segmentSymbols(cv: Cv, card: ImageData): SymbolRegion[] {
  let src: Cv = null;
  let rgb: Cv = null;
  let hsv: Cv = null;
  let channels: Cv = null;
  let saturationChannel: Cv = null;
  let valueChannel: Cv = null;
  let saturated: Cv = null;
  let dark: Cv = null;
  let ink: Cv = null;
  let contours: Cv = null;
  let hierarchy: Cv = null;
  try {
    src = cv.matFromImageData(card);
    rgb = new cv.Mat();
    hsv = new cv.Mat();
    channels = new cv.MatVector();
    saturated = new cv.Mat();
    dark = new cv.Mat();
    ink = new cv.Mat();
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();

    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.split(hsv, channels);
    // MatVector.get() allocates a fresh Mat header each call; bind
    // both so they can be freed (deleting `channels` does not)
    saturationChannel = channels.get(1);
    valueChannel = channels.get(2);
    cv.threshold(
      saturationChannel,
      saturated,
      MIN_INK_SATURATION,
      255,
      cv.THRESH_BINARY,
    );
    cv.threshold(valueChannel, dark, MAX_INK_VALUE, 255, cv.THRESH_BINARY_INV);
    cv.bitwise_or(saturated, dark, ink);

    // EXTERNAL: a striped/open symbol's outline stroke encloses its
    // interior, so stripes never surface as separate top-level regions
    cv.findContours(
      ink,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );

    const rasterArea = card.width * card.height;
    const regions: SymbolRegion[] = [];
    for (let i = 0; i < contours.size(); i++) {
      let contour: Cv = null;
      let hull: Cv = null;
      try {
        contour = contours.get(i);
        const area = cv.contourArea(contour);
        if (
          area >= rasterArea * MIN_SYMBOL_AREA_FRACTION &&
          area <= rasterArea * MAX_SYMBOL_AREA_FRACTION
        ) {
          hull = new cv.Mat();
          cv.convexHull(contour, hull);
          regions.push({
            outline: matToPoints(contour),
            hull: matToPoints(hull),
          });
        }
      } finally {
        hull?.delete();
        contour?.delete();
      }
    }
    // left-to-right for deterministic downstream behavior
    return regions.sort(
      (a, b) =>
        Math.min(...a.outline.map((p) => p.x)) -
        Math.min(...b.outline.map((p) => p.x)),
    );
  } finally {
    hierarchy?.delete();
    contours?.delete();
    ink?.delete();
    dark?.delete();
    saturated?.delete();
    valueChannel?.delete();
    saturationChannel?.delete();
    channels?.delete();
    hsv?.delete();
    rgb?.delete();
    src?.delete();
  }
}
