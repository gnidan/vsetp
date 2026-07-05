export interface Point {
  x: number;
  y: number;
}

// corner order: by angle about the centroid, rotated so a long edge
// of the card face maps to the rectified raster's top edge — a
// geometric first pass in vision/quad.ts (longest measured edge),
// content-verified against symbol evidence in
// vision/pipeline/orientation.ts
export type Quad = [Point, Point, Point, Point];
