import type { Fill } from "../../../model";
import type { SymbolRegion } from "../../adapter";
import { erodeMask, polygonArea, polygonMask } from "../regions";
import { rgbAt, saturationOf, whiteBalance } from "./pixels";

// erosion iterations to get past the outline stroke + anti-aliasing
const STROKE_EROSION = 8;
// Ink gate for the interior scan. Real stripes blur far below the
// stroke's saturation: measured stripe pixels on pic1326145 sit at
// S 0.10-0.20 while the old 0.25 gate saw striped interiors as
// 0.01-0.02 ink fraction — indistinguishable from open.
const FILL_INK_SATURATION = 0.1;

// Decision bands, all measured across the four tuning fixtures:
//
// ink fraction at the gate above:
//   solid + unresolved-striped read 0.75-1.00; resolved stripes read
//   0.14-0.19; open reads 0.00-0.09 on clean photos but up to 0.33 on
//   chroma-bleeding webp (halo hugs the stroke) — which is why a mid
//   fraction alone must NOT mean striped (transitions confirm).
const SOLID_MIN = 0.75;
// striped-vs-open fraction floor: measured striped >= 0.14, the
// noisiest open (which also alternates, trans 2.5) at 0.07
const STRIPED_MIN_FRACTION = 0.11;
// striped confirmation: mean ink<->white transitions per row.
// measured striped 2.4-5.1, open <= 1.9
const STRIPED_MIN_TRANSITIONS = 2;
// solid-vs-unresolved-tint split when the whole interior gates as
// ink: below CARD_RASTER resolution stripes melt into a uniform pale
// tint. Measured interior median saturation: real solids 0.53-1.00,
// tinted striped 0.12-0.21 (cards flagged as striped-by-judgment in
// SOURCE.md read exactly here).
const SOLID_MEDIAN_SATURATION = 0.35;
// Desaturated-stripe rescue: some striped cards print as fine GRAY
// lines (pic1326145's purple striped oval reads 0.00 ink fraction at
// any saturation gate) but still darken the interior. Median interior
// luma relative to the card's border white, measured across all four
// fixtures: open 0.985-1.03, striped (resolved, unresolved, or
// desaturated) 0.86-0.94, solid 0.40-0.55. An "open" verdict with a
// ratio at or below this bound is actually striped.
const OPEN_MIN_LUMA_RATIO = 0.96;
// ...but only when the interior sample is real: a fragmented region's
// eroded interior can be a handful of stroke pixels (pic1014255 had a
// 1-pixel interior read 0.55 and flip to striped). Whole-symbol
// interiors measure >= 0.048 of the raster.
const MIN_LUMA_SAMPLE_FRACTION = 0.01;
// Conversely a striped verdict needs a TRUSTED border: an interior
// measurably BRIGHTER than the card's own border ring means the quad
// overshot the card and the ring includes table/shadow (pic2934145's
// frame-edge card measured 1.25), so row alternation there is shadow
// noise. Real striped interiors measure 0.86-0.94 of border white.
const STRIPED_MAX_LUMA_RATIO = 1.05;
// A RESOLVED-striped verdict (fraction + alternation) additionally
// requires the interior's MEAN luma to be depressed by the stripe
// ink. Alternation alone can be a dim card's saturation noise
// flickering across the ink gate: pic421151's corner
// 2-purple-oval-open measured fraction 0.175 and transitions 2.25 —
// but its interior is as bright as the border. The MEDIAN cannot
// carry this check: crisp-striped interiors (stripes under 50%
// coverage, synthetic renderer) have a WHITE median (measured 1.015)
// — only the mean sees their ink. Measured mean-luma ratios: striped
// 0.794-0.804 (synthetic crisp) and 0.844-0.956 (all 16 real striped
// cards, every blur regime); the dim-noise open that reaches this
// branch 1.013. 0.98 splits them. (Chroma-halo opens measure means
// down to 0.922 but transitions <= 1.9 — they never get here.)
const STRIPED_MAX_MEAN_LUMA_RATIO = 0.98;
// fraction of the raster edge treated as known-white card border
// (mirrors whiteBalance's reference ring)
const BORDER_RING = 0.05;

function borderLuma(
  raster: ImageData,
  gains: [number, number, number],
): number {
  const { width, height } = raster;
  const rx = Math.max(2, Math.round(width * BORDER_RING));
  const ry = Math.max(2, Math.round(height * BORDER_RING));
  let sum = 0;
  let n = 0;
  for (let y = 0; y < height; y++) {
    const inBorderRow = y < ry || y >= height - ry;
    for (let x = 0; x < width; x++) {
      if (!inBorderRow && x >= rx && x < width - rx) continue;
      const [r, g, b] = rgbAt(raster, y * width + x, gains);
      sum += (r + g + b) / 3;
      n++;
    }
  }
  return n ? sum / n : 0;
}

export function classifyFill(
  raster: ImageData,
  regions: SymbolRegion[],
): { value: Fill; confidence: number } {
  if (regions.length === 0) return { value: "open", confidence: 0 };
  const region = regions.reduce((a, b) =>
    polygonArea(a.outline) >= polygonArea(b.outline) ? a : b,
  );
  const { width, height } = raster;
  const interior = erodeMask(
    polygonMask(region.outline, width, height),
    width,
    height,
    STROKE_EROSION,
  );
  const gains = whiteBalance(raster);

  let inked = 0;
  let total = 0;
  let transitions = 0;
  let rows = 0;
  const saturations: number[] = [];
  const lumas: number[] = [];
  for (let y = 0; y < height; y++) {
    let previous: boolean | undefined;
    let rowHasInterior = false;
    let rowTransitions = 0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!interior[i]) {
        // spans are not adjacent: don't count transitions across gaps
        previous = undefined;
        continue;
      }
      rowHasInterior = true;
      const [r, g, b] = rgbAt(raster, i, gains);
      const saturation = saturationOf(r, g, b);
      saturations.push(saturation);
      lumas.push((r + g + b) / 3);
      const isInk = saturation >= FILL_INK_SATURATION;
      total++;
      if (isInk) inked++;
      if (previous !== undefined && isInk !== previous) rowTransitions++;
      previous = isInk;
    }
    if (rowHasInterior) {
      rows++;
      transitions += rowTransitions;
    }
  }
  if (total === 0) return { value: "open", confidence: 0 };

  const inkFraction = inked / total;
  const meanTransitions = rows ? transitions / rows : 0;
  const median = saturations.sort((a, b) => a - b)[
    Math.floor(saturations.length / 2)
  ];
  const meanLuma = lumas.reduce((s, l) => s + l, 0) / lumas.length;
  const medianLuma = lumas.sort((a, b) => a - b)[Math.floor(lumas.length / 2)];
  const white = borderLuma(raster, gains);
  const lumaRatio = white > 0 ? medianLuma / white : 1;
  const meanLumaRatio = white > 0 ? meanLuma / white : 1;
  // an "open" verdict is only trusted if the interior is as bright as
  // the card border; darker means desaturated stripes (see
  // OPEN_MIN_LUMA_RATIO)
  const open = (confidence: number): { value: Fill; confidence: number } =>
    lumaRatio <= OPEN_MIN_LUMA_RATIO &&
    lumas.length >= raster.width * raster.height * MIN_LUMA_SAMPLE_FRACTION
      ? {
          value: "striped",
          confidence: Math.min(1, (OPEN_MIN_LUMA_RATIO - lumaRatio) * 8 + 0.3),
        }
      : { value: "open", confidence };

  if (inkFraction >= SOLID_MIN) {
    if (median >= SOLID_MEDIAN_SATURATION) {
      return {
        value: "solid",
        confidence: Math.min(1, (median - SOLID_MEDIAN_SATURATION) * 3 + 0.4),
      };
    }
    // whole interior gates as ink but far paler than real ink:
    // stripes below raster resolution (see SOLID_MEDIAN_SATURATION).
    // Unless the border is untrusted (see STRIPED_MAX_LUMA_RATIO):
    // then the "tint" is off-card shadow cast, not stripe ink —
    // measured tint-striped cards sit at luma ratio 0.86-0.91.
    if (lumaRatio > STRIPED_MAX_LUMA_RATIO) {
      return { value: "open", confidence: 0.3 };
    }
    return {
      value: "striped",
      confidence: Math.min(1, (SOLID_MEDIAN_SATURATION - median) * 3 + 0.2),
    };
  }
  if (
    inkFraction >= STRIPED_MIN_FRACTION &&
    meanTransitions >= STRIPED_MIN_TRANSITIONS &&
    meanLumaRatio <= STRIPED_MAX_MEAN_LUMA_RATIO
  ) {
    // resolved stripes: the interior actually alternates AND its
    // mean is darkened by stripe ink (see
    // STRIPED_MAX_MEAN_LUMA_RATIO — this bound also subsumes the
    // border-trust guard for this branch: an overshot quad's
    // interior means 1.137 against its polluted ring)
    return {
      value: "striped",
      confidence: Math.min(1, meanTransitions / 8 + 0.3),
    };
  }
  if (inkFraction < STRIPED_MIN_FRACTION) {
    return open(Math.min(1, (STRIPED_MIN_FRACTION - inkFraction) * 4 + 0.4));
  }
  // mid fraction without alternation: chroma halo around an open
  // symbol's stroke (measured up to 0.33 on pic2934145), not stripes
  return open(0.3);
}
