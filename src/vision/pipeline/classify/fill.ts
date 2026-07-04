import type { Fill } from "../../../model";
import type { SymbolRegion } from "../../adapter";
import { erodeMask, polygonArea, polygonMask } from "../regions";
import { rgbAt, saturationOf, whiteBalance } from "./pixels";

// erosion iterations to get past the outline stroke + anti-aliasing
const STROKE_EROSION = 8;
const MIN_INK_SATURATION = 0.25;
// ink-fraction decision bands (tuned against fixtures)
const SOLID_MIN = 0.75;
const OPEN_MAX = 0.15;
// striped confirmation: mean saturated<->white transitions per row
const STRIPED_MIN_TRANSITIONS = 2;

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
      const isInk = saturationOf(r, g, b) >= MIN_INK_SATURATION;
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

  if (inkFraction >= SOLID_MIN) {
    return {
      value: "solid",
      confidence: Math.min(1, (inkFraction - SOLID_MIN) * 3 + 0.4),
    };
  }
  if (inkFraction <= OPEN_MAX) {
    return {
      value: "open",
      confidence: Math.min(1, (OPEN_MAX - inkFraction) * 4 + 0.4),
    };
  }
  // mid ink-fraction: striped iff the interior actually alternates
  if (meanTransitions >= STRIPED_MIN_TRANSITIONS) {
    return {
      value: "striped",
      confidence: Math.min(1, meanTransitions / 8 + 0.3),
    };
  }
  // ambiguous: mid fraction but no alternation — lean by proximity
  const value: Fill =
    inkFraction > (SOLID_MIN + OPEN_MAX) / 2 ? "solid" : "open";
  return { value, confidence: 0.2 };
}
