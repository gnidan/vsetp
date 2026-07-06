import type {
  AttributeConfidence,
  Card,
  CardKey,
  Mark,
  Point,
  Quad,
  TrackId,
  TrackState,
} from "../model";
import { cardKey, trackId } from "../model";
import { aabbIou, centroid, distance, quadArea } from "./quad-utils";

export const TRACK_RETIRE_FRAMES = 8;
export const CONSENSUS_TO_LOCK = 3;
export const MAX_CONSENSUS_ATTEMPTS = 7;
export const CONSENSUS_GRACE_MS = 3000;
export const LIVE_CLASSIFY_BUDGET = 2;
export const REVERIFY_INTERVAL_FRAMES = 24; // ~2.4s @10fps
export const UNCERTAIN_RETRY_FRAMES = 20; // ~2s @10fps
export const MIN_MATCH_IOU = 0.2;
export const CENTROID_MATCH_FACTOR = 1.5; // × sqrt(track area)
export const AREA_UNLOCK_FACTOR = 2;
export const AREA_UNLOCK_FRAMES = 2;
export const FACE_MEMORY_RADIUS_FACTOR = 0.25; // × frame diagonal
export const SUPPRESSION_RADIUS_FACTOR = 0.75; // × sqrt(area)
export const SUPPRESSION_FALLBACK_RADIUS = 40; // px, 768-space

interface Consensus {
  votes: Record<string, number>; // CardKey -> vote count
  runKey: CardKey | null; // current consecutive-agreement key
  run: number;
  attempts: number;
}

function freshConsensus(): Consensus {
  return { votes: {}, runKey: null, run: 0, attempts: 0 };
}

export interface TrackRecord {
  id: TrackId;
  quad: Quad;
  state: TrackState;
  reading: Card | null;
  confidence: AttributeConfidence | null;
  provenance?: "roi-assist";
  missing: number; // consecutive unmatched frames
  consensus: Consensus;
  lastClassified: number; // frame ordinal, -Infinity initially
  lastVerified: number; // frame ordinal (locked re-verify)
  lockedArea: number | null;
  bigFrames: number; // consecutive frames area > 2x lockedArea
}

export interface Suppression {
  at: Point;
  radius: number;
}

export interface GraceTally {
  at: Point;
  radius: number;
  consensus: Consensus;
  expiresAtMs: number;
}

export interface TrackTable {
  nextId: number;
  ordinal: number; // processed-frame counter
  tracks: TrackRecord[];
  faceMemory: Map<CardKey, { card: Card; lastSeenAt: Point }>;
  suppressions: Suppression[];
  grace: GraceTally[];
  roiQueue: Point[];
}

export interface AdvanceInput {
  detections: Quad[];
  marks: Mark[];
  nowMs: number;
  frameSize: { width: number; height: number };
}

export interface AdvanceOutput {
  toClassify: { id: TrackId; quad: Quad }[];
  roiRequests: Point[];
}

export function createTrackTable(): TrackTable {
  return {
    nextId: 1,
    ordinal: 0,
    tracks: [],
    faceMemory: new Map(),
    suppressions: [],
    grace: [],
    roiQueue: [],
  };
}

// Step 2: apply marks. Mutates table.tracks / faceMemory / roiQueue,
// returns nothing — marks are resolved before matching so the same
// frame's detections see the post-mark track state.
function applyMarks(table: TrackTable, marks: Mark[]): void {
  for (const mark of marks) {
    if (mark.type === "wrong") {
      for (const track of table.tracks) {
        if (track.reading && cardKey(track.reading) === mark.key) {
          track.state = "reading";
          track.consensus = freshConsensus();
          track.lockedArea = null;
          track.bigFrames = 0;
        }
      }
      table.faceMemory.delete(mark.key);
      continue;
    }

    if (mark.type === "correct") {
      for (const track of table.tracks) {
        if (!track.reading || cardKey(track.reading) !== mark.key) {
          continue;
        }
        if (track.state === "reading" || track.state === "uncertain-locked") {
          track.state = "locked";
          track.lockedArea = quadArea(track.quad);
          track.lastVerified = table.ordinal;
          table.faceMemory.set(mark.key, {
            card: track.reading,
            lastSeenAt: centroid(track.quad),
          });
        } else if (track.state === "locked") {
          track.lastVerified = table.ordinal;
        }
      }
      continue;
    }

    if (mark.type === "not-a-card") {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < table.tracks.length; i++) {
        const track = table.tracks[i];
        const gate = CENTROID_MATCH_FACTOR * Math.sqrt(quadArea(track.quad));
        const d = distance(centroid(track.quad), mark.at);
        if (d <= gate && d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        const [removed] = table.tracks.splice(bestIdx, 1);
        const at = centroid(removed.quad);
        const radius =
          SUPPRESSION_RADIUS_FACTOR * Math.sqrt(quadArea(removed.quad));
        table.suppressions.push({ at, radius });
      } else {
        table.suppressions.push({
          at: mark.at,
          radius: SUPPRESSION_FALLBACK_RADIUS,
        });
      }
      continue;
    }

    if (mark.type === "missed-card") {
      table.roiQueue.push(mark.at);
    }
  }
}

// Step 3: filter detections against suppression circles.
function filterSuppressed(table: TrackTable, detections: Quad[]): Quad[] {
  if (table.suppressions.length === 0) return detections;
  return detections.filter((det) => {
    const c = centroid(det);
    return !table.suppressions.some((s) => distance(c, s.at) <= s.radius);
  });
}

const PRIORITY: Record<TrackState, number> = {
  locked: 0,
  "uncertain-locked": 0,
  reading: 1,
  tentative: 2,
};

// Steps 4-5: two-pass matching, then spawn tracks for leftovers.
function matchDetections(
  table: TrackTable,
  preExisting: TrackRecord[],
  detections: Quad[],
  nowMs: number,
): Set<TrackRecord> {
  const unclaimedDet = new Set(detections.map((_, i) => i));
  const matched = new Map<TrackRecord, Quad>();
  const fallbackMatched = new Set<TrackRecord>();

  const order = [...preExisting].sort((a, b) => {
    const pa = PRIORITY[a.state];
    const pb = PRIORITY[b.state];
    if (pa !== pb) return pa - pb;
    return a.id - b.id;
  });

  // Pass A: IoU primary.
  for (const track of order) {
    let bestIdx = -1;
    let bestIou = MIN_MATCH_IOU;
    for (const idx of unclaimedDet) {
      const iou = aabbIou(track.quad, detections[idx]);
      if (iou >= bestIou) {
        bestIou = iou;
        bestIdx = idx;
      }
    }
    if (bestIdx >= 0) {
      matched.set(track, detections[bestIdx]);
      unclaimedDet.delete(bestIdx);
    }
  }

  // Pass B: centroid fallback.
  for (const track of order) {
    if (matched.has(track)) continue;
    const gate = CENTROID_MATCH_FACTOR * Math.sqrt(quadArea(track.quad));
    let bestIdx = -1;
    let bestDist = Infinity;
    for (const idx of unclaimedDet) {
      const d = distance(centroid(track.quad), centroid(detections[idx]));
      if (d <= gate && d < bestDist) {
        bestDist = d;
        bestIdx = idx;
      }
    }
    if (bestIdx >= 0) {
      matched.set(track, detections[bestIdx]);
      fallbackMatched.add(track);
      unclaimedDet.delete(bestIdx);
    }
  }

  // Apply matches.
  for (const [track, det] of matched) {
    const wasLocked = track.state === "locked";
    track.quad = det;
    track.missing = 0;
    if (wasLocked && fallbackMatched.has(track)) {
      track.lastVerified = -Infinity;
    }
    if (wasLocked && track.lockedArea != null) {
      const area = quadArea(det);
      if (area > AREA_UNLOCK_FACTOR * track.lockedArea) {
        track.bigFrames += 1;
      } else {
        track.bigFrames = 0;
      }
      if (track.bigFrames >= AREA_UNLOCK_FRAMES) {
        track.state = "reading";
        track.consensus = freshConsensus();
        track.lockedArea = null;
        track.bigFrames = 0;
      }
    }
  }

  // Step 5: spawn tracks for unmatched detections.
  for (const idx of unclaimedDet) {
    const quad = detections[idx];
    const record: TrackRecord = {
      id: trackId(table.nextId++),
      quad,
      state: "tentative",
      reading: null,
      confidence: null,
      missing: 0,
      consensus: freshConsensus(),
      lastClassified: -Infinity,
      lastVerified: -Infinity,
      lockedArea: null,
      bigFrames: 0,
    };

    const c = centroid(quad);
    const graceIdx = table.grace.findIndex(
      (g) => g.expiresAtMs >= nowMs && distance(g.at, c) <= g.radius,
    );
    if (graceIdx >= 0) {
      const tally = table.grace[graceIdx];
      record.consensus = structuredClone(tally.consensus);
      record.state = "reading";
      table.grace.splice(graceIdx, 1);
    }

    table.tracks.push(record);
  }

  return new Set(matched.keys());
}

// Step 6: age tracks that existed before this frame's matching and
// were not matched (spawns from step 5 are exempt: they can't retire
// the same frame they're created).
function ageTracks(
  table: TrackTable,
  preExisting: TrackRecord[],
  matchedExisting: Set<TrackRecord>,
  nowMs: number,
): void {
  for (const track of preExisting) {
    if (!matchedExisting.has(track)) track.missing += 1;
  }

  const kept: TrackRecord[] = [];
  for (const track of table.tracks) {
    if (track.missing > TRACK_RETIRE_FRAMES) {
      if (track.state === "reading" && track.consensus.attempts > 0) {
        table.grace.push({
          at: centroid(track.quad),
          radius: CENTROID_MATCH_FACTOR * Math.sqrt(quadArea(track.quad)),
          consensus: structuredClone(track.consensus),
          expiresAtMs: nowMs + CONSENSUS_GRACE_MS,
        });
      }
      continue; // retired
    }
    kept.push(track);
  }
  table.tracks = kept;
}

// Step 7: purge expired grace tallies.
function purgeGrace(table: TrackTable, nowMs: number): void {
  table.grace = table.grace.filter((g) => g.expiresAtMs >= nowMs);
}

// Step 8: select tracks for live classification, budget-limited.
function selectClassify(table: TrackTable): { id: TrackId; quad: Quad }[] {
  const eligible = table.tracks.filter((t) => {
    if (t.missing > 0) return false;
    if (t.state === "tentative" || t.state === "reading") return true;
    if (t.state === "uncertain-locked") {
      return table.ordinal - t.lastClassified >= UNCERTAIN_RETRY_FRAMES;
    }
    return false;
  });
  eligible.sort((a, b) => a.lastClassified - b.lastClassified);
  const selected = eligible.slice(0, LIVE_CLASSIFY_BUDGET);

  if (selected.length < LIVE_CLASSIFY_BUDGET) {
    const dueLocked = table.tracks.filter(
      (t) =>
        t.state === "locked" &&
        t.missing === 0 &&
        table.ordinal - t.lastVerified >= REVERIFY_INTERVAL_FRAMES,
    );
    dueLocked.sort((a, b) => a.lastVerified - b.lastVerified);
    for (const track of dueLocked) {
      if (selected.length >= LIVE_CLASSIFY_BUDGET) break;
      selected.push(track);
    }
  }

  for (const track of selected) {
    track.lastClassified = table.ordinal;
  }

  return selected.map((t) => ({ id: t.id, quad: t.quad }));
}

export function advanceTracks(
  table: TrackTable,
  input: AdvanceInput,
): AdvanceOutput {
  table.ordinal += 1;

  applyMarks(table, input.marks);

  const filtered = filterSuppressed(table, input.detections);

  const preExisting = [...table.tracks];
  const matchedExisting = matchDetections(
    table,
    preExisting,
    filtered,
    input.nowMs,
  );

  ageTracks(table, preExisting, matchedExisting, input.nowMs);

  purgeGrace(table, input.nowMs);

  const toClassify = selectClassify(table);

  const roiRequests = table.roiQueue.splice(0);

  return { toClassify, roiRequests };
}
