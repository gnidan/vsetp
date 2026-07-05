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
// a 4-vertex simplification alone does not make a diamond: real
// flat-topped stadium ovals also simplify to 4 corners (pic1326145).
// A rhombus fills ~half its bounding box; measured across fixtures:
// diamonds 0.51-0.58, squiggles 0.71-0.77, ovals 0.81-0.88.
const DIAMOND_MAX_BBOX_FILL = 0.65;

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
  const xs = region.outline.map((p) => p.x);
  const ys = region.outline.map((p) => p.y);
  const bboxArea =
    (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  const bboxFill = outlineArea / Math.max(bboxArea, 1);
  if (vertices === 4 && solidity > 0.9 && bboxFill <= DIAMOND_MAX_BBOX_FILL) {
    // polygonal, convex-ish AND rhombus-like: diamond. Rounder
    // 4-vertex regions (stadium ovals, pinched squiggles) fall
    // through to the solidity/defect vote below.
    return {
      value: "diamond",
      confidence: Math.max(
        0,
        Math.min(1, (DIAMOND_MAX_BBOX_FILL - bboxFill) * 6 + 0.4),
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
