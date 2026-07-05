import type { Color } from "../../../model";
import type { SymbolRegion } from "../../adapter";
import {
  hueOf,
  regionMasks,
  rgbAt,
  saturationOf,
  whiteBalance,
} from "./pixels";

// hue prototypes (degrees) — tuned against fixtures
const PROTOTYPES: Record<Color, number> = {
  red: 5,
  green: 130,
  purple: 290,
};

// pixels below this saturation are card-white/anti-aliasing, not ink.
// 0.10 (not 0.25): the palest real outlines carry S 0.10-0.20 — at
// 0.25, pic1326145's open purple diamond had ZERO qualifying pixels
// and fell to the red default at confidence 0. Pixels are weighted by
// saturation below, so strong ink still dominates the mean when both
// are present.
const MIN_INK_SATURATION = 0.1;

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function classifyColor(
  raster: ImageData,
  regions: SymbolRegion[],
): { value: Color; confidence: number } {
  const gains = whiteBalance(raster);
  const mask = regionMasks(raster, regions);
  let x = 0;
  let y = 0; // mean hue as a saturation-weighted vector (circular mean)
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const [r, g, b] = rgbAt(raster, i, gains);
    const saturation = saturationOf(r, g, b);
    if (saturation < MIN_INK_SATURATION) continue;
    const radians = (hueOf(r, g, b) * Math.PI) / 180;
    x += saturation * Math.cos(radians);
    y += saturation * Math.sin(radians);
    n += saturation;
  }
  if (n === 0) return { value: "red", confidence: 0 };
  const meanHue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

  const distances = (Object.keys(PROTOTYPES) as Color[])
    .map((color) => ({
      color,
      d: hueDistance(meanHue, PROTOTYPES[color]),
    }))
    .sort((a, b) => a.d - b.d);
  const [best, runnerUp] = distances;
  // margin-based confidence, 0 when tied, ->1 as the winner dominates
  const confidence = (runnerUp.d - best.d) / Math.max(runnerUp.d + best.d, 1);
  return { value: best.color, confidence };
}
