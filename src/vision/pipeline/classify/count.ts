import type { Count } from "../../../model";
import type { SymbolRegion } from "../../adapter";
import { polygonArea } from "../regions";

// symbols on one card are the same size; regions far from the median
// area are debris (glare blobs, specks), not symbols. Band floor
// measured on the tuning fixtures: a dim symbol whose outline only
// partially closes still reads 0.39 of the median area (pic1014255's
// third purple squiggle) while true debris (broken-stroke fragments,
// border bleed) measures 0.08-0.20. Exported: orientation.ts applies
// the same band so debris cannot pollute the orientation vote either.
export const AREA_CONSISTENCY = { min: 0.3, max: 1.8 };

export function classifyCount(regions: SymbolRegion[]): {
  value: Count;
  confidence: number;
} {
  if (regions.length === 0) return { value: 1, confidence: 0 };

  const areas = regions.map((r) => polygonArea(r.outline));
  const median = [...areas].sort((a, b) => a - b)[Math.floor(areas.length / 2)];
  const plausible = areas.filter(
    (a) =>
      a >= median * AREA_CONSISTENCY.min && a <= median * AREA_CONSISTENCY.max,
  );
  const rejected = regions.length - plausible.length;

  const clamped = Math.min(3, Math.max(1, plausible.length)) as Count;
  // over-segmentation: more plausible regions than any card has
  if (plausible.length > 3) {
    return { value: clamped, confidence: 0.2 };
  }
  // consistency: how tightly the plausible areas cluster
  const spread =
    (Math.max(...plausible) - Math.min(...plausible)) / (median || 1);
  const consistency = Math.max(0, 1 - spread);
  const penalty = rejected > 0 ? 0.3 : 0;
  // floor at 0.2: an in-domain tally is never reported as
  // near-zero confidence, even with poor size consistency
  return {
    value: clamped,
    confidence: Math.max(0.2, consistency - penalty),
  };
}
