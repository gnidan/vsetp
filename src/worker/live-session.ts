import type { Track } from "../model";
import type { CardVision } from "../vision/adapter";
import { readCard } from "../vision/pipeline/read-card";
import { detectCardsInRoi } from "../vision/pipeline/roi";
import type { LivePending, MarkEntry } from "./live-mailbox";
import {
  adoptRoiDetection,
  advanceTracks,
  applyClassifications,
  createTrackTable,
  projectTracks,
} from "./tracker";
import type { ClassificationResult, TrackTable } from "./tracker";

// The worker-side live seam: everything a live session accumulates
// across frames lives in the track table, so the session is
// Node-testable without a Worker (spec: live engine).
export interface LiveSession {
  table: TrackTable;
}

export function createLiveSession(): LiveSession {
  return { table: createTrackTable() };
}

// The whole live pipeline for one frame: detect, advance tracks
// (marks included), classify within budget, run ROI-assist requests,
// project. `read` is injectable so tests can script per-quad
// readings without an OpenCV-backed CardVision.
export function processLiveFrame(
  vision: CardVision,
  session: LiveSession,
  pending: LivePending,
  marks: MarkEntry[],
  nowMs: number,
  read: typeof readCard = readCard,
): { tracks: Track[]; timings: Record<string, number> } {
  const { frame, captureMs, options } = pending;
  const timings: Record<string, number> = { capture: captureMs };
  const image = new ImageData(
    new Uint8ClampedArray(frame.pixels),
    frame.width,
    frame.height,
  );
  const t0 = performance.now();
  const detections = vision.detectCards(image, options);
  timings.detect = performance.now() - t0;

  const t1 = performance.now();
  const out = advanceTracks(session.table, {
    detections,
    marks: marks.map((entry) => entry.mark),
    nowMs,
    frameSize: { width: frame.width, height: frame.height },
  });
  const results: ClassificationResult[] = out.toClassify.map(({ id, quad }) => {
    const result = read(vision, image, quad);
    return {
      id,
      outcome: result
        ? { card: result.card, confidence: result.confidence }
        : null,
    };
  });
  applyClassifications(session.table, results, nowMs);
  timings.classify = performance.now() - t1;

  const t2 = performance.now();
  for (const at of out.roiRequests) {
    const found = detectCardsInRoi(vision, image, at);
    if (found.length > 0) {
      adoptRoiDetection(session.table, found[0]);
    }
  }
  timings.roi = performance.now() - t2;

  return { tracks: projectTracks(session.table), timings };
}
