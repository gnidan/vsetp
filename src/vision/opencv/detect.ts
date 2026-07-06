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
// physical card aspect is ~1.56, but perspective foreshortening moves
// the measured minAreaRect aspect a long way in both directions:
// tuning fixtures show real cards at 1.08 (pic1326145 near row, camera
// close overhead) up to 2.24 (pic1014255 shallow oblique). Band is
// those extremes plus a small margin.
const CARD_ASPECT_RANGE = { min: 1.05, max: 2.35 };
// ROI missed-card assist (relaxed detection, see DetectOptions.relaxed):
// the user has already asserted a card is here, so the aspect band
// widens and the area floor halves to admit more foreshortened/small
// candidates. Consensus across frames still guards false positives.
const RELAXED_ASPECT_RANGE = { min: 0.9, max: 2.6 };
const RELAXED_AREA_FRACTION_SCALE = 0.5;
// glancing-angle tableaus (pic4609830) compress cards much further:
// measured fully-visible cards sit at 2.4-3.1 and the exposed strips
// of overlapped cards at 3.8-4.9. Only the steep-overlap strategy —
// which runs after the ordinary bands have already failed — accepts
// up to this ceiling; globally it would admit merged pairs and deck
// stacks (measured junk at 2.8-3.3 in pic1326145).
const STEEP_ASPECT_MAX = 5.0;
// below this many quads, a strategy is assumed to have failed to
// separate cards from the background, and the next one is tried
const MIN_PLAUSIBLE_CARDS = 3;

// One-nicked-corner rescue: a card whose contour approximates to 5
// vertices (a corner clipped by shadow or frame edge) still fills its
// minAreaRect almost completely — measured 0.97 on pic2934145's
// rotated squiggle card vs <= 0.78 for every junk blob (deck stacks,
// logo boxes) across the fixtures. Such blobs are accepted with the
// rect corners as the quad. Applies at the GLOBAL aspect band only
// (never the steep ceiling): overlapped card pairs are also
// rectangular, and the rescue must not admit them as single cards.
const NICKED_RECT_VERTICES = 5;
const NICKED_MIN_RECT_FILL = 0.9;

// cluster splitting: a rejected blob at least this many card-minimums
// in area may be several cards merged across a narrow gap or an
// incomplete edge cut; it is re-eroded in SPLIT_STEP increments until
// card-shaped sub-blobs separate
const MIN_CLUSTER_CARDS = 2;
// blobs above this fraction of the frame are not a merged run of
// cards (e.g. an edge-closed whole tableau); splitting them only
// manufactures junk quads
const MAX_CLUSTER_AREA_FRACTION = 0.35;
const SPLIT_STEP = 2;
// safety bound on accumulated split erosion (working-scale px); a gap
// this wide would have separated in the binary already
const MAX_SPLIT_EROSION = 16;

interface Candidate {
  points: Point[]; // 4 corners, working scale
  erosion: number; // total erosion applied; compensated on output
}

interface ExtractOptions {
  aspectMin: number; // effective global band (relaxed-adjustable)
  aspectMax: number; // primary-check ceiling: per-strategy (may be steep)
  globalAspectMax: number; // effective global band max; never the
  // steep ceiling (see NICKED_RECT_VERTICES)
  minAreaFraction: number; // effective floor (relaxed-adjustable)
  splitBudget: number;
}

type Evaluation =
  { kind: "card"; points: Point[] } | { kind: "cluster" } | { kind: "reject" };

function evaluateContour(
  cv: Cv,
  contour: Cv,
  imageArea: number,
  options: ExtractOptions,
): Evaluation {
  const area = cv.contourArea(contour);
  if (area < imageArea * options.minAreaFraction) return { kind: "reject" };
  let approx: Cv = null;
  try {
    approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, 0.02 * cv.arcLength(contour, true), true);
    if (
      area <= imageArea * MAX_CARD_AREA_FRACTION &&
      approx.rows === 4 &&
      cv.isContourConvex(approx)
    ) {
      const rect = cv.minAreaRect(approx);
      const long = Math.max(rect.size.width, rect.size.height);
      const short = Math.min(rect.size.width, rect.size.height);
      const aspect = long / Math.max(short, 1);
      if (aspect >= options.aspectMin && aspect <= options.aspectMax) {
        const points: Point[] = [];
        for (let p = 0; p < 4; p++) {
          points.push({
            x: approx.data32S[p * 2],
            y: approx.data32S[p * 2 + 1],
          });
        }
        return { kind: "card", points };
      }
    }
    if (
      area <= imageArea * MAX_CARD_AREA_FRACTION &&
      approx.rows === NICKED_RECT_VERTICES
    ) {
      // see NICKED_RECT_VERTICES: one clipped corner, near-perfect
      // rect fill — take the minAreaRect corners as the quad
      const rect = cv.minAreaRect(approx);
      const long = Math.max(rect.size.width, rect.size.height);
      const short = Math.min(rect.size.width, rect.size.height);
      const aspect = long / Math.max(short, 1);
      const rectFill = area / Math.max(long * short, 1);
      if (
        rectFill >= NICKED_MIN_RECT_FILL &&
        aspect >= options.aspectMin &&
        aspect <= options.globalAspectMax
      ) {
        const radians = (rect.angle * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        const hw = rect.size.width / 2;
        const hh = rect.size.height / 2;
        const points = [
          { x: -hw, y: -hh },
          { x: hw, y: -hh },
          { x: hw, y: hh },
          { x: -hw, y: hh },
        ].map((p) => ({
          x: rect.center.x + p.x * cos - p.y * sin,
          y: rect.center.y + p.x * sin + p.y * cos,
        }));
        return { kind: "card", points };
      }
    }
    if (
      area >= imageArea * options.minAreaFraction * MIN_CLUSTER_CARDS &&
      area <= imageArea * MAX_CLUSTER_AREA_FRACTION
    ) {
      return { kind: "cluster" };
    }
    return { kind: "reject" };
  } finally {
    approx?.delete();
  }
}

// redraw one rejected cluster blob filled (interior holes sealed),
// erode it one step, and re-extract candidates from what separates
function splitCluster(
  cv: Cv,
  contour: Cv,
  rows: number,
  cols: number,
  erosion: number,
  options: ExtractOptions,
): Candidate[] {
  let scratch: Cv = null;
  let blob: Cv = null;
  let kernel: Cv = null;
  try {
    scratch = cv.Mat.zeros(rows, cols, cv.CV_8UC1);
    blob = new cv.MatVector();
    blob.push_back(contour);
    cv.drawContours(scratch, blob, 0, new cv.Scalar(255), -1);
    kernel = cv.getStructuringElement(
      cv.MORPH_ELLIPSE,
      new cv.Size(2 * SPLIT_STEP + 1, 2 * SPLIT_STEP + 1),
    );
    cv.erode(scratch, scratch, kernel);
    return candidatesFromBinary(cv, scratch, erosion + SPLIT_STEP, {
      ...options,
      splitBudget: options.splitBudget - SPLIT_STEP,
    });
  } finally {
    kernel?.delete();
    blob?.delete();
    scratch?.delete();
  }
}

function candidatesFromBinary(
  cv: Cv,
  binary: Cv,
  erosion: number,
  options: ExtractOptions,
): Candidate[] {
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
      try {
        const evaluation = evaluateContour(cv, contour, imageArea, options);
        if (evaluation.kind === "card") {
          found.push({ points: evaluation.points, erosion });
        } else if (evaluation.kind === "cluster" && options.splitBudget > 0) {
          found.push(
            ...splitCluster(
              cv,
              contour,
              binary.rows,
              binary.cols,
              erosion,
              options,
            ),
          );
        }
      } finally {
        contour.delete();
      }
    }
    return found;
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

// Exact inverse of disk erosion for a convex polygon: shift each edge
// outward along its normal by `by` and re-intersect adjacent edges.
// (Radial vertex growth under-compensates corners by 1/sin(theta/2),
// which matters once accumulated split erosion exceeds a few px.)
function offsetConvex(points: Point[], by: number): Point[] {
  const n = points.length;
  let signed = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    signed += a.x * b.y - b.x * a.y;
  }
  const sign = signed > 0 ? 1 : -1;
  const edges = points.map((a, i) => {
    const b = points[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    return {
      ax: a.x + ((sign * dy) / length) * by,
      ay: a.y + ((-sign * dx) / length) * by,
      dx,
      dy,
    };
  });
  return points.map((_p, i) => {
    const e1 = edges[(i - 1 + n) % n];
    const e2 = edges[i];
    const det = e1.dx * e2.dy - e1.dy * e2.dx;
    if (Math.abs(det) < 1e-9) {
      // adjacent edges parallel (degenerate); fall back to the
      // shifted edge start rather than a far intersection
      return { x: e2.ax, y: e2.ay };
    }
    const t = ((e2.ax - e1.ax) * e2.dy - (e2.ay - e1.ay) * e2.dx) / det;
    return { x: e1.ax + t * e1.dx, y: e1.ay + t * e1.dy };
  });
}

// Edge-interiors fallback for white-cards-on-light-tables: card
// borders survive as Canny gradients even when no global threshold
// separates card from table (pic421151 measured: cream cards on tan
// under an illumination gradient — even a second-pass Otsu on the
// light half of the histogram splits the frame by brightness side,
// not card-vs-table). The dilated edge lattice encloses each card's
// interior; those enclosed smooth regions ARE the card candidates.
//
// Canny band: at the prior 40/120 the dim-corner card borders of
// pic421151 have gaps, and 16 of 20 interiors leak into the table
// component (which exceeds MAX_CARD_AREA_FRACTION and is dropped);
// measured accepted interiors by (low/high, dilate diameter):
// 40/120: 4-5; 30/90: 13; 20/60: 14-15; 15/45+7px: 20/20 with zero
// junk quads; 10/30 over-merges back down to 18. Extra edges from
// the low band are harmless here — they only subdivide the table
// into slivers the aspect/vertex gates already reject.
const EDGE_LATTICE_CANNY = { low: 15, high: 45 };
// dilation RADIUS sealing residual border gaps; radius 2 still leaks
// one card on pic421151 (19/20), radius 3 seals all 20
const EDGE_LATTICE_SEAL = 3;
// the Canny line itself sits ON the card border; the interior is
// inset by the seal radius plus roughly half that line's width
// (calibration below against synthetic truth quads)
const EDGE_INTERIOR_LINE_HALF_WIDTH = 1;

function binaryFromEdgeInteriors(
  cv: Cv,
  gray: Cv,
  minAreaFraction: number,
): Cv {
  let edges: Cv = null;
  let kernel: Cv = null;
  let contours: Cv = null;
  let hierarchy: Cv = null;
  let rebuilt: Cv = null;
  try {
    edges = new cv.Mat();
    kernel = cv.getStructuringElement(
      cv.MORPH_ELLIPSE,
      new cv.Size(2 * EDGE_LATTICE_SEAL + 1, 2 * EDGE_LATTICE_SEAL + 1),
    );
    cv.Canny(gray, edges, EDGE_LATTICE_CANNY.low, EDGE_LATTICE_CANNY.high);
    cv.dilate(edges, edges, kernel); // seal soft/broken card borders
    cv.bitwise_not(edges, edges); // white = smooth enclosed regions
    // Card interiors can be nested arbitrarily deep (inside the hole
    // of a table region, itself inside a black photo-frame border), so
    // RETR_EXTERNAL would never see them. RETR_CCOMP puts the outer
    // boundary of EVERY white component at the top level regardless of
    // nesting; redraw the card-area-plausible ones filled. The area
    // ceiling is load-bearing twice over: a filled redraw of a huge
    // component (table lattice, photo margin) would also paint over
    // the card interiors nested in its holes.
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(
      edges,
      contours,
      hierarchy,
      cv.RETR_CCOMP,
      cv.CHAIN_APPROX_SIMPLE,
    );
    rebuilt = cv.Mat.zeros(edges.rows, edges.cols, cv.CV_8UC1);
    const imageArea = edges.rows * edges.cols;
    for (let i = 0; i < contours.size(); i++) {
      if (hierarchy.data32S[i * 4 + 3] !== -1) continue; // hole: skip
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      contour.delete();
      if (area < imageArea * minAreaFraction) continue;
      if (area > imageArea * MAX_CARD_AREA_FRACTION) continue;
      cv.drawContours(rebuilt, contours, i, new cv.Scalar(255), -1);
    }
    const result = rebuilt;
    rebuilt = null;
    return result;
  } finally {
    rebuilt?.delete();
    hierarchy?.delete();
    contours?.delete();
    kernel?.delete();
    edges?.delete();
  }
}

export function detectCards(
  cv: Cv,
  frame: ImageData,
  options?: DetectOptions,
): Quad[] {
  const maxDimension = options?.maxDimension ?? DETECTION_MAX_DIMENSION;
  const scale = Math.min(1, maxDimension / Math.max(frame.width, frame.height));
  // ROI missed-card assist: widen the aspect band and halve the area
  // floor once here, then thread the same derived limits to every
  // gate site below (see DetectOptions.relaxed and RELAXED_*).
  const aspectMin = options?.relaxed
    ? RELAXED_ASPECT_RANGE.min
    : CARD_ASPECT_RANGE.min;
  const aspectMax = options?.relaxed
    ? RELAXED_ASPECT_RANGE.max
    : CARD_ASPECT_RANGE.max;
  const minAreaFraction = options?.relaxed
    ? MIN_CARD_AREA_FRACTION * RELAXED_AREA_FRACTION_SCALE
    : MIN_CARD_AREA_FRACTION;
  let src: Cv = null;
  let working: Cv = null;
  let kernel: Cv = null;
  try {
    src = cv.matFromImageData(frame);
    working = new cv.Mat();
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

    const otsuBinary = () => {
      let binary: Cv = null;
      try {
        binary = new cv.Mat();
        cv.threshold(
          working,
          binary,
          0,
          255,
          cv.THRESH_BINARY + cv.THRESH_OTSU,
        );
        cv.erode(binary, binary, kernel);
        const result = binary;
        binary = null;
        return result;
      } finally {
        binary?.delete();
      }
    };

    // Steep-overlap rescue (pic4609830-class frames): cards laid
    // overlapping have no background gap at all — the only separator
    // is the gradient line where one card crosses another. Cut those
    // Canny lines OUT of the Otsu binary, then let cluster splitting
    // finish any cut that does not quite sever.
    const edgeCutBinary = () => {
      let edges: Cv = null;
      let cutKernel: Cv = null;
      let binary: Cv = null;
      try {
        edges = new cv.Mat();
        // 3x3: keep cuts thin so far (small) cards survive the cut
        cutKernel = cv.getStructuringElement(
          cv.MORPH_ELLIPSE,
          new cv.Size(3, 3),
        );
        cv.Canny(working, edges, 40, 120);
        cv.dilate(edges, edges, cutKernel);
        cv.bitwise_not(edges, edges);
        binary = otsuBinary(); // already eroded by SPLIT_EROSION
        cv.bitwise_and(binary, edges, binary);
        const result = binary;
        binary = null;
        return result;
      } finally {
        binary?.delete();
        cutKernel?.delete();
        edges?.delete();
      }
    };

    const fromBinary =
      (make: () => Cv, erosion: number, extract: ExtractOptions) =>
      (): Candidate[] => {
        const binary = make();
        try {
          return candidatesFromBinary(cv, binary, erosion, extract);
        } finally {
          binary.delete();
        }
      };

    const strategies: Array<() => Candidate[]> = [
      // primary: global Otsu separates white cards from the table
      fromBinary(otsuBinary, SPLIT_EROSION, {
        aspectMin,
        aspectMax,
        globalAspectMax: aspectMax,
        minAreaFraction,
        splitBudget: 0,
      }),
      // steep-overlap rescue; wider aspect ceiling because glancing
      // angles compress cards past the ordinary band (see constant).
      // globalAspectMax stays the ordinary (relaxed-adjustable) band:
      // the nicked-rect rescue never admits the steep ceiling.
      fromBinary(edgeCutBinary, SPLIT_EROSION, {
        aspectMin,
        aspectMax: STEEP_ASPECT_MAX,
        globalAspectMax: aspectMax,
        minAreaFraction,
        splitBudget: MAX_SPLIT_EROSION,
      }),
      // light-background fallback (see binaryFromEdgeInteriors); the
      // interior quads sit inside the card border by the lattice seal
      // radius plus the Canny line's half-width, compensated like an
      // erosion
      fromBinary(
        () => binaryFromEdgeInteriors(cv, working, minAreaFraction),
        EDGE_LATTICE_SEAL + EDGE_INTERIOR_LINE_HALF_WIDTH,
        {
          aspectMin,
          aspectMax,
          globalAspectMax: aspectMax,
          minAreaFraction,
          splitBudget: 0,
        },
      ),
    ];

    // Arbitration is "most candidates wins" with an early break once
    // any strategy reaches MIN_PLAUSIBLE_CARDS. Known limitation:
    // for genuinely sparse frames (1-2 cards) a later strategy can
    // outvote a correct earlier result with junk quads. Revisit with
    // real-photo data if holdout photos hit it (tuning fixtures do
    // not; see .superpowers/sdd/tuning-report.md).
    let best: Candidate[] = [];
    for (const strategy of strategies) {
      const candidates = strategy();
      if (candidates.length > best.length) best = candidates;
      if (best.length >= MIN_PLAUSIBLE_CARDS) break;
    }

    return best
      .map((c) =>
        orderQuad(
          offsetConvex(c.points, c.erosion).map((p) => ({
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
    working?.delete();
    src?.delete();
  }
}
