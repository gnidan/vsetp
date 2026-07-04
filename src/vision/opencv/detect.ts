import type { Point, Quad } from "../../model";
import type { DetectOptions } from "../adapter";
import { DETECTION_MAX_DIMENSION } from "../adapter";
import { orderQuad } from "../quad";
import type { Cv } from "./cv";

// erosion radius (working-scale px) used to split near-touching cards;
// corners are compensated outward by the same amount afterward
const SPLIT_EROSION = 2;
const MIN_CARD_AREA_FRACTION = 0.003;
const MAX_CARD_AREA_FRACTION = 0.25;
const CARD_ASPECT_RANGE = { min: 1.2, max: 2.0 };

interface Candidate {
  points: Point[]; // 4 corners, working scale
}

function candidatesFromBinary(cv: Cv, binary: Cv): Candidate[] {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(
      binary,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );
    const found: Candidate[] = [];
    const imageArea = binary.rows * binary.cols;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      let approx: Cv = null;
      try {
        const area = cv.contourArea(contour);
        if (
          area < imageArea * MIN_CARD_AREA_FRACTION ||
          area > imageArea * MAX_CARD_AREA_FRACTION
        ) {
          continue;
        }
        approx = new cv.Mat();
        cv.approxPolyDP(
          contour,
          approx,
          0.02 * cv.arcLength(contour, true),
          true,
        );
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const rect = cv.minAreaRect(approx);
          const long = Math.max(rect.size.width, rect.size.height);
          const short = Math.min(rect.size.width, rect.size.height);
          const aspect = long / Math.max(short, 1);
          if (
            aspect >= CARD_ASPECT_RANGE.min &&
            aspect <= CARD_ASPECT_RANGE.max
          ) {
            const points: Point[] = [];
            for (let p = 0; p < 4; p++) {
              points.push({
                x: approx.data32S[p * 2],
                y: approx.data32S[p * 2 + 1],
              });
            }
            found.push({ points });
          }
        }
      } finally {
        approx?.delete();
        contour.delete();
      }
    }
    return found;
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

function grow(points: Point[], by: number): Point[] {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return points.map((p) => {
    const d = Math.hypot(p.x - cx, p.y - cy) || 1;
    return { x: p.x + ((p.x - cx) / d) * by, y: p.y + ((p.y - cy) / d) * by };
  });
}

export function detectCards(
  cv: Cv,
  frame: ImageData,
  options?: DetectOptions,
): Quad[] {
  const maxDimension = options?.maxDimension ?? DETECTION_MAX_DIMENSION;
  const scale = Math.min(1, maxDimension / Math.max(frame.width, frame.height));
  let src: Cv = null;
  let working: Cv = null;
  let binary: Cv = null;
  let kernel: Cv = null;
  try {
    src = cv.matFromImageData(frame);
    working = new cv.Mat();
    binary = new cv.Mat();
    kernel = cv.getStructuringElement(
      cv.MORPH_ELLIPSE,
      new cv.Size(2 * SPLIT_EROSION + 1, 2 * SPLIT_EROSION + 1),
    );
    cv.resize(
      src,
      working,
      new cv.Size(
        Math.round(frame.width * scale),
        Math.round(frame.height * scale),
      ),
      0,
      0,
      cv.INTER_AREA,
    );
    cv.cvtColor(working, working, cv.COLOR_RGBA2GRAY);
    cv.threshold(working, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.erode(binary, binary, kernel);
    const candidates = candidatesFromBinary(cv, binary);
    return candidates
      .map((c) =>
        orderQuad(
          grow(c.points, SPLIT_EROSION).map((p) => ({
            x: p.x / scale,
            y: p.y / scale,
          })),
        ),
      )
      .sort((a, b) => {
        const ya = a.reduce((s, p) => s + p.y, 0);
        const yb = b.reduce((s, p) => s + p.y, 0);
        const xa = a.reduce((s, p) => s + p.x, 0);
        const xb = b.reduce((s, p) => s + p.x, 0);
        return ya - yb || xa - xb;
      });
  } finally {
    kernel?.delete();
    binary?.delete();
    working?.delete();
    src?.delete();
  }
}
