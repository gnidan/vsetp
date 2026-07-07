import type { Mark, Point } from "../model";
import { ROI_SPAN_FACTOR } from "../vision/pipeline/roi";
import { LIVE_FRAME_MAX_DIMENSION } from "./live-capture";

// How close (live-frame px) a found roi-assist track must be to a
// missed-card mark to count as its resolution: any card the ROI
// detector finds lies inside the crop around the mark, whose
// half-span at the live frame's long edge is exactly this.
export const FACE_RADIUS = (ROI_SPAN_FACTOR * LIVE_FRAME_MAX_DIMENSION) / 2;

export interface FeedbackEntry {
  at: number;
  mark: Mark;
  outcome?: "roi-found";
  resolvedAt?: number;
}

export interface FeedbackLog {
  record(mark: Mark, at: number): void;
  // resolve the most recent unresolved missed-card within FACE_RADIUS
  noteRoiFound(near: Point, at: number): void;
  entries(): FeedbackEntry[];
  toJson(): string; // { marks: [...] } convertible to fixture labels
}

export function createFeedbackLog(): FeedbackLog {
  const marks: FeedbackEntry[] = [];
  return {
    record(mark, at) {
      marks.push({ at, mark });
    },
    noteRoiFound(near, at) {
      for (let i = marks.length - 1; i >= 0; i--) {
        const entry = marks[i];
        if (entry.mark.type !== "missed-card" || entry.outcome) continue;
        const d = Math.hypot(
          entry.mark.at.x - near.x,
          entry.mark.at.y - near.y,
        );
        if (d <= FACE_RADIUS) {
          marks[i] = { ...entry, outcome: "roi-found", resolvedAt: at };
          return;
        }
      }
    },
    entries() {
      return marks.slice();
    },
    toJson() {
      return JSON.stringify({ marks }, null, 2);
    },
  };
}
