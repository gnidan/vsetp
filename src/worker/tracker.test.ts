import { describe, expect, it } from "vitest";
import type { Mark, Quad } from "../model";
import {
  advanceTracks,
  createTrackTable,
  LIVE_CLASSIFY_BUDGET,
  TRACK_RETIRE_FRAMES,
} from "./tracker";

const FRAME = { width: 768, height: 576 };

const rect = (x: number, y: number, w = 90, h = 58): Quad => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

function step(
  table: ReturnType<typeof createTrackTable>,
  detections: Quad[],
  marks: Mark[] = [],
  nowMs = 0,
) {
  return advanceTracks(table, {
    detections,
    marks,
    nowMs,
    frameSize: FRAME,
  });
}

describe("advanceTracks matching", () => {
  it("spawns tentative tracks for new detections", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10), rect(200, 10)]);
    expect(table.tracks).toHaveLength(2);
    expect(table.tracks.every((t) => t.state === "tentative")).toBe(true);
  });

  it("keeps trackId stable under drift (IoU match)", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    step(table, [rect(16, 13)]); // small drift, high IoU
    expect(table.tracks).toHaveLength(1);
    expect(table.tracks[0].id).toBe(id);
  });

  it("rejects a force-match beyond the gates (spawns instead)", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    step(table, [rect(600, 400)]); // far: no IoU, beyond centroid gate
    const ids = table.tracks.map((t) => t.id);
    expect(ids).toContain(id); // old track survives (missing=1)
    expect(table.tracks).toHaveLength(2); // far detection spawned new
  });

  it("retires a track after TRACK_RETIRE_FRAMES misses", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    for (let i = 0; i <= TRACK_RETIRE_FRAMES; i++) step(table, []);
    expect(table.tracks).toHaveLength(0);
  });

  it("dense grid: adjacent cards keep their own tracks", () => {
    const table = createTrackTable();
    // two cards 100px apart, then both drift 8px right
    step(table, [rect(100, 100), rect(200, 100)]);
    const [a, b] = table.tracks.map((t) => t.id);
    step(table, [rect(108, 100), rect(208, 100)]);
    const byX = [...table.tracks].sort((t, u) => t.quad[0].x - u.quad[0].x);
    expect(byX[0].id).toBe(a);
    expect(byX[1].id).toBe(b);
  });
});

describe("advanceTracks marks", () => {
  it("not-a-card removes the track and suppresses re-detections", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    step(table, [rect(10, 10)], [{ type: "not-a-card", at: { x: 55, y: 39 } }]);
    expect(table.tracks).toHaveLength(0);
    step(table, [rect(10, 10)]); // re-detected at same spot
    expect(table.tracks).toHaveLength(0); // suppressed
  });

  it("missed-card queues an roi request", () => {
    const table = createTrackTable();
    const out = step(
      table,
      [],
      [{ type: "missed-card", at: { x: 300, y: 300 } }],
    );
    expect(out.roiRequests).toEqual([{ x: 300, y: 300 }]);
    // drained: next frame has none
    expect(step(table, []).roiRequests).toEqual([]);
  });
});

describe("advanceTracks classify budget", () => {
  it("selects at most LIVE_CLASSIFY_BUDGET oldest unlocked", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10), rect(200, 10), rect(400, 10)]);
    const out = step(table, [rect(10, 10), rect(200, 10), rect(400, 10)]);
    expect(out.toClassify).toHaveLength(LIVE_CLASSIFY_BUDGET);
  });

  it("does not classify a track that went unmatched this frame", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const out = step(table, []); // track missing this frame
    expect(out.toClassify).toHaveLength(0);
  });
});
