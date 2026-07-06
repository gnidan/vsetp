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

// The ladder's V ceilings are absolute, but card brightness is not:
// pic421151's dim-corner cards measure border (white-reference)
// median V of only 134-146 — BELOW even the strictest 140 ceiling —
// so on every rung the whole card face gated as one giant ink region
// (0.65-0.81 of the raster, discarded as > MAX_SYMBOL_AREA_FRACTION)
// and the card was dropped as zero-region/face-down, or the face
// patches merged into the symbol regions and mangled their hulls.
// A border-RELATIVE rung fixes those cards: dark means dark compared
// to the card's own white. It is appended to the ladder rather than
// capping the absolute rungs, because the two bands overlap ACROSS
// cards: pic1014255's palest open strokes ride the dark arm up to
// 0.875 x their borderV (V 160-175, borderV 200) while pic421151's
// face pixels reach DOWN to 0.86 x theirs (face p01 115-127, borderV
// 134-146) — a global cap that admits the former admits the latter
// (measured: fraction 0.75 broke pic1014255/pic2934145 purple opens;
// 0.85 still clipped pic1014255's 1-purple-oval-open outline into a
// squiggle hull). As its own rung, the relative ceiling only wins a
// card when it scores strictly better than every absolute rung
// (more whole symbols / fewer fragments), so cards the absolute
// ladder already reads stay exactly as they were.
//
// Ceiling fraction: the relative dark arm's customers are solid
// purple symbols — the only ink that is dark AND desaturated on the
// dim cards — at p10 <= 0.66 x borderV (58-122 at borderV 145-185);
// face pixels start at 0.86 x borderV (above). 0.75 splits the
// bands with margin on both sides. S floor stays at the strictest
// 40: outline strokes on the dim pic421151 cards still measure S
// p99 122-204, while their low-S face noise must not enter.
const RELATIVE_DARK_GATE = {
  minSaturation: 40,
  maxValueBorderFraction: 0.75,
};

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

    // border-ring median V: the card's own white-reference brightness
    // (see RELATIVE_DARK_GATE)
    const borderV: number[] = [];
    for (let y = 0; y < card.height; y++) {
      const inBorderRow = y < ringY || y >= card.height - ringY;
      for (let x = 0; x < card.width; x++) {
        if (!inBorderRow && x >= ringX && x < card.width - ringX) continue;
        borderV.push(valueChannel.data[y * card.width + x]);
      }
    }
    borderV.sort((a, b) => a - b);
    const borderMedianV = borderV[borderV.length >> 1];
    const gates = [
      ...INK_GATES,
      {
        minSaturation: RELATIVE_DARK_GATE.minSaturation,
        maxValue: Math.round(
          borderMedianV * RELATIVE_DARK_GATE.maxValueBorderFraction,
        ),
      },
    ];

    let best: SymbolRegion[] = [];
    let bestScore = -Infinity;
    for (const gate of gates) {
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
