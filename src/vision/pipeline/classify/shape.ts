import type { Shape } from "../../../model";
import type { SymbolRegion } from "../../adapter";
import {
  maxHullDeviation,
  perimeter,
  polygonArea,
  simplifyPolygon,
} from "../regions";

// DP epsilon as a fraction of perimeter (spec: epsilon specified this
// way so it scales with symbol size)
const SIMPLIFY_EPSILON_FRACTION = 0.03;
// a squiggle's solidity sits ~0.90-0.95 vs an oval's ~0.97-0.99;
// defect depth (relative to sqrt(area)) is the stronger signal
const SQUIGGLE_SOLIDITY = 0.955;
const SQUIGGLE_DEFECT_RATIO = 0.05;

export function classifyShape(regions: SymbolRegion[]): {
  value: Shape;
  confidence: number;
} {
  if (regions.length === 0) return { value: "oval", confidence: 0 };
  const region = regions.reduce((a, b) =>
    polygonArea(a.outline) >= polygonArea(b.outline) ? a : b,
  );

  const outlineArea = polygonArea(region.outline);
  const hullArea = polygonArea(region.hull);
  const solidity = hullArea > 0 ? outlineArea / hullArea : 1;
  const defectRatio =
    maxHullDeviation(region.outline, region.hull) /
    Math.max(Math.sqrt(outlineArea), 1);

  const epsilon = SIMPLIFY_EPSILON_FRACTION * perimeter(region.outline);
  const vertices = simplifyPolygon(region.outline, epsilon).length;

  // feature vote
  if (vertices === 4 && solidity > 0.9) {
    // polygonal and convex-ish: diamond. Confidence from how far
    // solidity sits above the squiggle band.
    return {
      value: "diamond",
      confidence: Math.max(
        0,
        Math.min(1, (solidity - SQUIGGLE_SOLIDITY) * 12 + 0.5),
      ),
    };
  }
  const squiggleVotes =
    Number(solidity < SQUIGGLE_SOLIDITY) +
    Number(defectRatio > SQUIGGLE_DEFECT_RATIO);
  if (squiggleVotes === 2) {
    return {
      value: "squiggle",
      confidence: Math.min(
        1,
        (SQUIGGLE_SOLIDITY - solidity) * 10 +
          (defectRatio - SQUIGGLE_DEFECT_RATIO) * 5 +
          0.4,
      ),
    };
  }
  if (squiggleVotes === 1) {
    // features disagree: pick by the stronger deviation, low confidence
    const value: Shape =
      defectRatio > SQUIGGLE_DEFECT_RATIO ? "squiggle" : "oval";
    return { value, confidence: 0.3 };
  }
  return {
    value: "oval",
    confidence: Math.min(1, (solidity - SQUIGGLE_SOLIDITY) * 15 + 0.4),
  };
}
