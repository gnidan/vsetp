import type { Point, Quad } from "../model";

// detection working scale, long edge px
export const DETECTION_MAX_DIMENSION = 1024;

// capture normalization clamp, long edge px (used in Plan B; defined
// here because it is coupled to the raster budget below)
export const NORMALIZED_MAX_DIMENSION = 3072;

// canonical rectified card raster. Long edge horizontal; sized so a
// symbol's short axis lands ~100+ px => >=8 px per stripe pair, which
// is what striped-vs-solid classification needs (see spec).
export const CARD_RASTER = { width: 600, height: 384 } as const;

// Outer fraction of a rectified card raster treated as known-white
// card border: symbols never reach it by construction. Segmentation
// blanks this ring in the ink mask (segment.ts), white balance
// samples it as the neutral reference (classify/pixels.ts), and
// withoutRingHuggers rejects regions flush against its inner edge —
// that flush geometry only works because all three use this ONE
// value. Defined here (plain-data home, like CARD_RASTER) because
// pipeline code must not import from vision/opencv.
export const BORDER_RING = 0.05;

export interface DetectOptions {
  maxDimension?: number; // default DETECTION_MAX_DIMENSION
  relaxed?: boolean; // ROI assist: widen gates (default false)
}

export interface SymbolRegion {
  outline: Point[]; // filled OUTER ink boundary, raster coords
  hull: Point[]; // its convex hull
}

// The task-level vision adapter. Implementations own ALL library
// specifics (OpenCV et al.); plain data in and out.
//
// Cost note: implementations re-ingest the full frame per call (a
// 3072px frame is ~28MB uploaded once for detectCards and once per
// rectifyCard). Measured well within the 500ms budget for still
// frames; if live mode changes that, the sanctioned evolution is a
// frame-session/handle variant of this interface (see spec), not
// caching inside implementations.
export interface CardVision {
  // find card-shaped regions; quads in input-frame coordinates
  detectCards(frame: ImageData, options?: DetectOptions): Quad[];

  // perspective-correct one card to CARD_RASTER
  rectifyCard(frame: ImageData, quad: Quad): ImageData;

  // find symbol regions within a rectified card, fill-invariant
  segmentSymbols(card: ImageData): SymbolRegion[];
}
