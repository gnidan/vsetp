import type { Quad } from "../model";

// Validated line palette (see .superpowers/sdd/line-demo.png). Colors
// are assigned by array-order set index and never reshuffled by
// selection; selection emphasizes by WEIGHT, not hue.
export const SET_LINE_COLORS = [
  "#22d3ee",
  "#fbbf24",
  "#f472b6",
  "#a5b4fc",
] as const;
export const SET_LINE_CASING = "#0a1420";
export const SET_LINE_DASH = "28 18";

// Selection emphasizes by WEIGHT, never hue — shared between the
// still (index-colored) and live (identity-colored) line renderers.
export function setLineWeights(selected: boolean): {
  coreWidth: number;
  casingWidth: number;
} {
  return {
    coreWidth: selected ? 12 : 8,
    casingWidth: selected ? 20 : 16,
  };
}

export function setLineStyle(
  index: number,
  selected: boolean,
): {
  color: string;
  dash: string | null;
  coreWidth: number;
  casingWidth: number;
} {
  return {
    color: SET_LINE_COLORS[index % SET_LINE_COLORS.length],
    dash: index >= 4 ? SET_LINE_DASH : null,
    ...setLineWeights(selected),
  };
}

function centroid(quad: Quad): { x: number; y: number } {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}

// SVG points string through the quads' centroids; rendered as a
// <polygon>, which closes the triangle.
export function triangleFor(quads: Quad[]): string {
  return quads
    .map(centroid)
    .map((p) => `${p.x},${p.y}`)
    .join(" ");
}
