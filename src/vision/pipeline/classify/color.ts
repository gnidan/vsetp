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

// pixels below this saturation are card-white/anti-aliasing, not ink
const MIN_INK_SATURATION = 0.25;

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
  let y = 0; // mean hue as a vector (circular mean)
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const [r, g, b] = rgbAt(raster, i, gains);
    if (saturationOf(r, g, b) < MIN_INK_SATURATION) continue;
    const radians = (hueOf(r, g, b) * Math.PI) / 180;
    x += Math.cos(radians);
    y += Math.sin(radians);
    n++;
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
