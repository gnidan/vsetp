export interface Point {
  x: number;
  y: number;
}

// corner order: by angle about the centroid, rotated so the longest
// edge maps to the rectified raster's top edge (see vision/quad.ts)
export type Quad = [Point, Point, Point, Point];
