import type { SymbolRegion } from "../adapter";
import type { Cv } from "./cv";

// a symbol must occupy a sane fraction of the raster
const MIN_SYMBOL_AREA_FRACTION = 0.01;
const MAX_SYMBOL_AREA_FRACTION = 0.35;

// ink = notably saturated OR notably dark (catches all three colors
// on the white card face). The gates assume the raster is
// white-balanced (analyze does this): balanced card faces measure
// HSV S p95 <= 46 across the tuning fixtures while the palest real
// strokes (blurry low-res open outlines, pic2934145) peak at only
// 45-80 — the original S=60 gate missed them entirely. Gates are a
// ladder: if a gate finds no symbol at all, the next (more permissive)
// one is tried — every Set card has symbols, so zero regions is a
// certain miss, and cards whose faces are too noisy for the permissive
// gates never reach them.
const INK_GATES: { minSaturation: number; maxValue: number }[] = [
  { minSaturation: 40, maxValue: 140 },
  { minSaturation: 30, maxValue: 150 },
  { minSaturation: 25, maxValue: 160 },
  // dim + blurred cards (pic1014255's vignetted right column) carry
  // strokes at S 15-43; only cards whose faces are clean enough to
  // find nothing at the rungs above ever descend here
  { minSaturation: 20, maxValue: 170 },
  { minSaturation: 15, maxValue: 175 },
];

// seal breaks in pale/blurry outline strokes before contour
// extraction: a broken open-symbol outline otherwise decomposes into
// thin arc strips that all fall below MIN_SYMBOL_AREA_FRACTION
// (pic2934145's low-res open diamonds/ovals). 5px is well below the
// inter-symbol spacing (~60px) at CARD_RASTER scale.
const INK_CLOSE_KERNEL = 5;

// gate scoring: regions at least this large are plausibly WHOLE
// symbols. Measured whole symbols occupy 0.088-0.14 of the raster
// (diamonds smallest); broken-outline fragments that barely clear
// MIN_SYMBOL_AREA_FRACTION measure ~0.011 (pic2934145 card 3).
// Every gate runs and the best-scoring wins: whole symbols (capped at
// a card's maximum of 3) score high, fragments penalize, and earlier
// (stricter) gates win ties so clean cards never pick up a permissive
// gate's noise. First-whole-wins stopped too early on pic1014255's
// dim cards: one diamond closed three rungs before its two siblings.
const MIN_WHOLE_SYMBOL_FRACTION = 0.04;

function gateScore(whole: number, fragments: number): number {
  return Math.min(whole, 3) * 10 - fragments;
}

// outer fraction of the raster blanked in the ink mask: it is the
// white-reference border ring by construction (symbols never reach
// it), and off-card bleed there (colored tablecloth, shadow) otherwise
// reads as ink and can merge with a symbol under the permissive gates
const BORDER_RING = 0.05;

function matToPoints(mat: Cv): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < mat.rows; i++) {
    points.push({ x: mat.data32S[i * 2], y: mat.data32S[i * 2 + 1] });
  }
  return points;
}

function regionsFromInk(
  cv: Cv,
  ink: Cv,
  rasterArea: number,
): { regions: SymbolRegion[]; whole: number } {
  let contours: Cv = null;
  let hierarchy: Cv = null;
  try {
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    // EXTERNAL: a striped/open symbol's outline stroke encloses its
    // interior, so stripes never surface as separate top-level regions
    cv.findContours(
      ink,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );
    const regions: SymbolRegion[] = [];
    let whole = 0;
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
          if (area >= rasterArea * MIN_WHOLE_SYMBOL_FRACTION) {
            whole++;
          }
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
    return { regions, whole };
  } finally {
    hierarchy?.delete();
    contours?.delete();
  }
}

export function segmentSymbols(cv: Cv, card: ImageData): SymbolRegion[] {
  let src: Cv = null;
  let rgb: Cv = null;
  let hsv: Cv = null;
  let channels: Cv = null;
  let saturationChannel: Cv = null;
  let valueChannel: Cv = null;
  let closeKernel: Cv = null;
  try {
    src = cv.matFromImageData(card);
    rgb = new cv.Mat();
    hsv = new cv.Mat();
    channels = new cv.MatVector();

    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.split(hsv, channels);
    // MatVector.get() allocates a fresh Mat header each call; bind
    // both so they can be freed (deleting `channels` does not)
    saturationChannel = channels.get(1);
    valueChannel = channels.get(2);
    closeKernel = cv.getStructuringElement(
      cv.MORPH_ELLIPSE,
      new cv.Size(INK_CLOSE_KERNEL, INK_CLOSE_KERNEL),
    );

    const rasterArea = card.width * card.height;
    const ringX = Math.max(2, Math.round(card.width * BORDER_RING));
    const ringY = Math.max(2, Math.round(card.height * BORDER_RING));

    let best: SymbolRegion[] = [];
    let bestScore = -Infinity;
    for (const gate of INK_GATES) {
      let saturated: Cv = null;
      let dark: Cv = null;
      let ink: Cv = null;
      let interior: Cv = null;
      try {
        saturated = new cv.Mat();
        dark = new cv.Mat();
        ink = new cv.Mat();
        cv.threshold(
          saturationChannel,
          saturated,
          gate.minSaturation,
          255,
          cv.THRESH_BINARY,
        );
        cv.threshold(
          valueChannel,
          dark,
          gate.maxValue,
          255,
          cv.THRESH_BINARY_INV,
        );
        cv.bitwise_or(saturated, dark, ink);
        // blank the border ring (see BORDER_RING)
        interior = cv.Mat.zeros(ink.rows, ink.cols, cv.CV_8UC1);
        cv.rectangle(
          interior,
          new cv.Point(ringX, ringY),
          new cv.Point(ink.cols - 1 - ringX, ink.rows - 1 - ringY),
          new cv.Scalar(255),
          -1,
        );
        cv.bitwise_and(ink, interior, ink);
        cv.morphologyEx(ink, ink, cv.MORPH_CLOSE, closeKernel);

        const { regions, whole } = regionsFromInk(cv, ink, rasterArea);
        const score = gateScore(whole, regions.length - whole);
        if (regions.length > 0 && score > bestScore) {
          bestScore = score;
          best = regions;
        }
      } finally {
        interior?.delete();
        ink?.delete();
        dark?.delete();
        saturated?.delete();
      }
    }
    // left-to-right for deterministic downstream behavior
    return best.sort(
      (a, b) =>
        Math.min(...a.outline.map((p) => p.x)) -
        Math.min(...b.outline.map((p) => p.x)),
    );
  } finally {
    closeKernel?.delete();
    valueChannel?.delete();
    saturationChannel?.delete();
    channels?.delete();
    hsv?.delete();
    rgb?.delete();
    src?.delete();
  }
}
