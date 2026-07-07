import { beforeAll, describe, expect, it } from "vitest";
import type { CardKey, Frame, Point, Quad, Track } from "../src/model";
import { cardKey } from "../src/model";
import type { CardVision } from "../src/vision/adapter";
import { createCardVision } from "../src/vision/opencv";
import { loadOpenCv } from "../src/vision/opencv/load-node";
import type { MarkEntry } from "../src/worker/live-mailbox";
import {
  createLiveSession,
  processLiveFrame,
} from "../src/worker/live-session";
import {
  CONSENSUS_TO_LOCK,
  LIVE_CLASSIFY_BUDGET,
  TRACK_RETIRE_FRAMES,
} from "../src/worker/tracker";
import { LIVE_FRAME_MAX_DIMENSION } from "../src/app/live-capture";
import type { SequenceStep } from "./synthetic/sequence";
import { projectToFrame, renderSequence } from "./synthetic/sequence";

// 3x3 tableau of distinct faces, varied across every attribute.
const GRID_KEYS = [
  "1-red-oval-solid",
  "2-green-diamond-striped",
  "3-purple-squiggle-open",
  "1-green-squiggle-open",
  "2-purple-oval-solid",
  "3-red-diamond-striped",
  "1-purple-diamond-striped",
  "2-red-squiggle-open",
  "3-green-oval-solid",
] as CardKey[];

// Grid pitch 480x384 table-space px (>= 220 spec minimum), margins
// wide enough that +-15px drift never clips a card at a window edge.
const GRID = GRID_KEYS.map((key, i) => ({
  key,
  at: { x: 288 + (i % 3) * 480, y: 192 + Math.floor(i / 3) * 384 },
}));

// Frame-count arithmetic, derived from the engine's own constants so
// the scenarios stay valid if those are tuned:
//
// - Nine fresh tracks each need CONSENSUS_TO_LOCK consecutive
//   agreeing reads and the engine classifies LIVE_CLASSIFY_BUDGET
//   tracks per frame round-robin, so full convergence takes
//   ceil(9*3/2) = 14 frames; +2 slack for an off read. (The task
//   brief's nominal 12 frames give only 24 classify slots — round-
//   robined over 9 tracks that locks 6, so its own ">= 8 locked"
//   assertion could never pass; the assertions are the spec.)
const CONVERGE_FRAMES =
  Math.ceil((GRID.length * CONSENSUS_TO_LOCK) / LIVE_CLASSIFY_BUDGET) + 2;
// - A track retires after missing > TRACK_RETIRE_FRAMES consecutive
//   frames, so an empty span must run 9 frames before the table
//   empties; +1 slack. (The brief's nominal 3 empty frames cannot
//   retire anything.)
const AWAY_FRAMES = TRACK_RETIRE_FRAMES + 2;
// - On return every track relocks on its FIRST classification (face
//   memory), so all nine relock as soon as each has had one classify
//   slot: ceil(9/2) = 5 frames.
const RETURN_FRAMES = Math.ceil(GRID.length / LIVE_CLASSIFY_BUDGET);

// Camera drift: consecutive steps move at most +-15px per axis in
// table space.
const DRIFT_CYCLE = [
  { dx: 0, dy: 0 },
  { dx: 15, dy: 0 },
  { dx: 15, dy: 15 },
  { dx: 0, dy: 15 },
  { dx: -15, dy: 15 },
  { dx: -15, dy: 0 },
  { dx: -15, dy: -15 },
  { dx: 0, dy: -15 },
];
const DRIFT_STEPS: SequenceStep[] = Array.from(
  { length: CONVERGE_FRAMES },
  (_, i) => ({ scale: 1, ...DRIFT_CYCLE[i % DRIFT_CYCLE.length] }),
);

const ON_TABLE: SequenceStep = { scale: 1, dx: 0, dy: 0 };
// Far off-table: the window sees nothing but felt.
const OFF_TABLE: SequenceStep = { scale: 1, dx: 2200, dy: 0 };

function runSequence(
  vision: CardVision,
  frames: Frame[],
  marksAt: Record<number, MarkEntry[]> = {},
) {
  const session = createLiveSession();
  const updates = frames.map((frame, i) =>
    processLiveFrame(
      vision,
      session,
      { frame, captureMs: 0 },
      marksAt[i] ?? [],
      i * 100,
    ),
  );
  return { session, updates };
}

function centroid(quad: Quad): Point {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}

// The placed face nearest a frame-space point under a given camera
// step — pairs tracked centroids with ground truth.
function expectedKeyAt(step: SequenceStep, p: Point): CardKey {
  const nearest = GRID.reduce((a, b) => {
    const pa = projectToFrame(step, a.at);
    const pb = projectToFrame(step, b.at);
    return Math.hypot(pa.x - p.x, pa.y - p.y) <=
      Math.hypot(pb.x - p.x, pb.y - p.y)
      ? a
      : b;
  });
  return nearest.key;
}

function trackIdSet(tracks: Track[]): string {
  return tracks
    .map((t) => t.trackId)
    .sort((a, b) => a - b)
    .join(",");
}

function locked(tracks: Track[]): Track[] {
  return tracks.filter((t) => t.state === "locked");
}

describe("renderSequence", () => {
  it("produces frames of the live working size", async () => {
    const frames = await renderSequence({
      cards: [{ key: "1-red-oval-solid" as CardKey, at: { x: 300, y: 300 } }],
      steps: [
        { scale: 1, dx: 0, dy: 0 },
        { scale: 1, dx: 20, dy: 10 },
      ],
    });
    expect(frames).toHaveLength(2);
    expect(Math.max(frames[0].width, frames[0].height)).toBe(
      LIVE_FRAME_MAX_DIMENSION,
    );
    for (const frame of frames) {
      expect(frame.pixels.byteLength).toBe(frame.width * frame.height * 4);
    }
    expect(frames[0].id).not.toBe(frames[1].id);
  });
});

describe("live integration (real pipeline)", { timeout: 120_000 }, () => {
  let vision: CardVision;
  beforeAll(async () => {
    vision = createCardVision(await loadOpenCv());
  }, 30_000);

  // Scenarios 1 and 3 assert over the same drift run; render and
  // process it once.
  let driftRun: Promise<{ updates: { tracks: Track[] }[] }> | undefined;
  function drift() {
    driftRun ??= renderSequence({ cards: GRID, steps: DRIFT_STEPS }).then(
      (frames) => runSequence(vision, frames),
    );
    return driftRun;
  }

  it("converges to locks under camera drift without track churn", async () => {
    const { updates } = await drift();

    // Continuity: the same nine tracks persist from frame 2 on — no
    // spurious spawns, no retirements.
    expect(updates[1].tracks).toHaveLength(GRID.length);
    const ids = trackIdSet(updates[1].tracks);
    for (const update of updates.slice(1)) {
      expect(trackIdSet(update.tracks)).toBe(ids);
    }

    // Convergence: by the final frame at least 8 of 9 are locked...
    const final = updates[updates.length - 1];
    const lockedTracks = locked(final.tracks);
    expect(lockedTracks.length).toBeGreaterThanOrEqual(GRID.length - 1);

    // ...and every locked reading is the face placed at that spot.
    const lastStep = DRIFT_STEPS[DRIFT_STEPS.length - 1];
    for (const track of lockedTracks) {
      expect(track.reading).toBeDefined();
      expect(cardKey(track.reading!)).toBe(
        expectedKeyAt(lastStep, centroid(track.quad)),
      );
    }
  });

  it("retires tracks off-table and relocks instantly on return", async () => {
    const steps: SequenceStep[] = [
      ...Array.from({ length: CONVERGE_FRAMES }, () => ON_TABLE),
      ...Array.from({ length: AWAY_FRAMES }, () => OFF_TABLE),
      ...Array.from({ length: RETURN_FRAMES }, () => ON_TABLE),
    ];
    const frames = await renderSequence({ cards: GRID, steps });
    const { updates } = runSequence(vision, frames);

    // The tableau fully locks before the pan (face memory holds all
    // nine faces).
    const beforePan = updates[CONVERGE_FRAMES - 1];
    expect(locked(beforePan.tracks)).toHaveLength(GRID.length);

    // During the empty span tracks retire to zero.
    const lastAway = updates[CONVERGE_FRAMES + AWAY_FRAMES - 1];
    expect(lastAway.tracks).toHaveLength(0);

    // On return, relocks are INSTANT (first classification hits face
    // memory): after 3 frames only 3 * LIVE_CLASSIFY_BUDGET tracks
    // have even been classified once — none could have the
    // CONSENSUS_TO_LOCK reads a from-scratch lock needs — so every
    // one of those slots must already be locked.
    const returnAt = CONVERGE_FRAMES + AWAY_FRAMES;
    const threeIn = updates[returnAt + 2];
    expect(locked(threeIn.tracks).length).toBeGreaterThanOrEqual(
      3 * LIVE_CLASSIFY_BUDGET,
    );

    // Once every track has had one classify slot, all nine are locked
    // again and the readings match the original faces.
    const final = updates[updates.length - 1];
    const relocked = locked(final.tracks);
    expect(relocked).toHaveLength(GRID.length);
    for (const track of relocked) {
      expect(cardKey(track.reading!)).toBe(
        expectedKeyAt(ON_TABLE, centroid(track.quad)),
      );
    }
  });

  it("never flickers a locked reading between consecutive updates", async () => {
    const { updates } = await drift();

    let previous = new Map<number, string>();
    for (const update of updates) {
      const current = new Map<number, string>();
      for (const track of locked(update.tracks)) {
        expect(track.reading).toBeDefined();
        current.set(track.trackId, cardKey(track.reading!));
      }
      for (const [id, key] of current) {
        const before = previous.get(id);
        if (before !== undefined) expect(key).toBe(before);
      }
      previous = current;
    }
  });
});
