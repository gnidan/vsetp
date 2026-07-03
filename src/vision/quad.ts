import type { Point, Quad } from "../model";

// Order 4 corners: clockwise (screen coords) by angle about the
// centroid, then rotated so the longest edge is (q[0] -> q[1]). This
// fixes orientation up to a 180-degree flip, which classification is
// deliberately invariant to (see spec).
export function orderQuad(points: Point[]): Quad {
  if (points.length !== 4) {
    throw new Error(`orderQuad needs 4 points, got ${points.length}`);
  }
  const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
  const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;
  const byAngle = [...points].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  let longest = 0;
  let longestLength = -1;
  for (let i = 0; i < 4; i++) {
    const a = byAngle[i];
    const b = byAngle[(i + 1) % 4];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > longestLength) {
      longestLength = length;
      longest = i;
    }
  }
  return [
    byAngle[longest],
    byAngle[(longest + 1) % 4],
    byAngle[(longest + 2) % 4],
    byAngle[(longest + 3) % 4],
  ] as Quad;
}
