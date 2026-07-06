import { describe, expect, it } from "vitest";
import { allCards, cardFromKey, cardKey } from "../model";
import type { CardKey, Mark, Quad } from "../model";
import {
  advanceTracks,
  applyClassifications,
  CONSENSUS_TO_LOCK,
  createTrackTable,
  LIVE_CLASSIFY_BUDGET,
  MAX_CONSENSUS_ATTEMPTS,
  projectTracks,
  REVERIFY_INTERVAL_FRAMES,
  TRACK_RETIRE_FRAMES,
  UNCERTAIN_RETRY_FRAMES,
} from "./tracker";

const FRAME = { width: 768, height: 576 };

const CARD_A = cardFromKey("1-red-oval-solid" as CardKey);
const CARD_B = cardFromKey("1-red-diamond-solid" as CardKey);
const CARD_C = cardFromKey("1-green-oval-solid" as CardKey);
const conf = { count: 1, color: 1, shape: 1, fill: 1 };

function classify(table: any, id: any, card: any, nowMs = 0) {
  applyClassifications(
    table,
    [{ id, outcome: { card, confidence: conf } }],
    nowMs,
  );
}

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

describe("consensus and locking", () => {
  it("locks after CONSENSUS_TO_LOCK consecutive agreeing reads", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    for (let i = 0; i < CONSENSUS_TO_LOCK; i++) {
      step(table, [rect(10, 10)]);
      classify(table, id, CARD_A);
    }
    expect(table.tracks[0].state).toBe("locked");
    expect(cardKey(table.tracks[0].reading!)).toBe("1-red-oval-solid");
  });

  it("oscillating reads escape to uncertain-locked (plurality)", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    const seq = Array.from({ length: MAX_CONSENSUS_ATTEMPTS }, (_, i) =>
      i % 2 === 0 ? CARD_A : CARD_B,
    );
    for (const card of seq) {
      step(table, [rect(10, 10)]);
      classify(table, id, card);
    }
    expect(table.tracks[0].state).toBe("uncertain-locked");
    expect(cardKey(table.tracks[0].reading!)).toBe("1-red-oval-solid");
  });

  it("vote tie: current runKey wins when it is among the leaders", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    // A:3, B:3, C:1 — no run reaches 3; ends on A, so runKey=A
    const seq = [CARD_A, CARD_B, CARD_A, CARD_B, CARD_C, CARD_B, CARD_A];
    expect(seq).toHaveLength(MAX_CONSENSUS_ATTEMPTS);
    for (const card of seq) {
      step(table, [rect(10, 10)]);
      classify(table, id, card);
    }
    expect(table.tracks[0].state).toBe("uncertain-locked");
    // leaders {A, B}; runKey A is among them -> A (NOT the
    // lexicographically smaller "1-red-diamond-solid")
    expect(cardKey(table.tracks[0].reading!)).toBe("1-red-oval-solid");
  });

  it("vote tie: lexicographically smallest leader when runKey lost", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    // A:3, B:3, C:1 — ends on C, so runKey=C is NOT a leader
    const seq = [CARD_A, CARD_B, CARD_A, CARD_B, CARD_A, CARD_B, CARD_C];
    expect(seq).toHaveLength(MAX_CONSENSUS_ATTEMPTS);
    for (const card of seq) {
      step(table, [rect(10, 10)]);
      classify(table, id, card);
    }
    expect(table.tracks[0].state).toBe("uncertain-locked");
    // leaders {"1-red-oval-solid", "1-red-diamond-solid"}: smallest
    expect(cardKey(table.tracks[0].reading!)).toBe("1-red-diamond-solid");
  });

  it("a locked track is not re-selected before the re-verify interval", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    for (let i = 0; i < CONSENSUS_TO_LOCK; i++) {
      step(table, [rect(10, 10)]);
      classify(table, id, CARD_A);
    }
    const out = step(table, [rect(10, 10)]);
    expect(out.toClassify).toHaveLength(0);
  });

  it("re-verify: disagreeing re-read demotes and self-heals (swap)", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    for (let i = 0; i < CONSENSUS_TO_LOCK; i++) {
      step(table, [rect(10, 10)]);
      classify(table, id, CARD_A);
    }
    // idle past the re-verify interval; the lock becomes due
    let selected: any[] = [];
    for (let i = 0; i <= REVERIFY_INTERVAL_FRAMES; i++) {
      selected = step(table, [rect(10, 10)]).toClassify;
    }
    expect(selected.map((s) => s.id)).toContain(id);
    // the physical card was swapped: re-read disagrees
    classify(table, id, CARD_B);
    expect(table.tracks[0].state).toBe("reading");
    // consensus on the new face re-locks
    for (let i = 0; i < CONSENSUS_TO_LOCK - 1; i++) {
      step(table, [rect(10, 10)]);
      classify(table, id, CARD_B);
    }
    expect(table.tracks[0].state).toBe("locked");
    expect(cardKey(table.tracks[0].reading!)).toBe("1-red-diamond-solid");
  });
});

describe("unreadable-track retry cadence", () => {
  it("null-only reads back off to the uncertain retry cadence", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    // card-shaped but unreadable: every classification returns null
    for (let i = 0; i < MAX_CONSENSUS_ATTEMPTS; i++) {
      const out = step(table, [rect(10, 10)]);
      expect(out.toClassify.map((s) => s.id)).toContain(id);
      applyClassifications(table, [{ id, outcome: null }], 0);
    }
    // immediately following frames: no longer selected every rotation
    for (let i = 1; i < UNCERTAIN_RETRY_FRAMES; i++) {
      const out = step(table, [rect(10, 10)]);
      expect(out.toClassify).toHaveLength(0);
    }
    // after UNCERTAIN_RETRY_FRAMES frames it becomes eligible again
    const out = step(table, [rect(10, 10)]);
    expect(out.toClassify.map((s) => s.id)).toContain(id);
  });
});

describe("face memory", () => {
  function lockAt(table: any, x: number, y: number, card: any) {
    step(table, [rect(x, y)]);
    const id = table.tracks.find(
      (t: any) => t.quad[0].x === x && t.state !== "locked",
    ).id;
    for (let i = 0; i < CONSENSUS_TO_LOCK; i++) {
      step(table, [rect(x, y)]);
      classify(table, id, card);
    }
    return id;
  }

  it("reattaches a known face near its last position instantly", () => {
    const table = createTrackTable();
    lockAt(table, 10, 10, CARD_A);
    // pan away: retire everything
    for (let i = 0; i <= TRACK_RETIRE_FRAMES; i++) step(table, []);
    expect(table.tracks).toHaveLength(0);
    // pan back: same spot, FIRST read matches memory -> instant lock
    step(table, [rect(14, 12)]);
    const id = table.tracks[0].id;
    step(table, [rect(14, 12)]);
    classify(table, id, CARD_A);
    expect(table.tracks[0].state).toBe("locked");
  });

  it("does NOT instant-lock an unknown face (validates, never creates)", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    step(table, [rect(10, 10)]);
    classify(table, id, CARD_A); // no memory entry for CARD_A
    expect(table.tracks[0].state).toBe("reading"); // consensus path
  });

  it("rejects spatially implausible reattachment", () => {
    const table = createTrackTable();
    lockAt(table, 10, 10, CARD_A);
    for (let i = 0; i <= TRACK_RETIRE_FRAMES; i++) step(table, []);
    // reappears across the table (beyond 25% of diagonal)
    step(table, [rect(650, 500)]);
    const id = table.tracks[0].id;
    step(table, [rect(650, 500)]);
    classify(table, id, CARD_A);
    expect(table.tracks[0].state).toBe("reading"); // no teleport lock
  });

  it("never steals a key claimed by a live locked track", () => {
    const table = createTrackTable();
    lockAt(table, 10, 10, CARD_A);
    // second card nearby misread as the SAME face on first read
    step(table, [rect(10, 10), rect(140, 10)]);
    const other = table.tracks.find((t: any) => t.state === "tentative")!;
    step(table, [rect(10, 10), rect(140, 10)]);
    classify(table, other.id, CARD_A);
    expect(other.state).toBe("reading"); // consensus, not instant lock
  });

  it("wrong mark evicts face memory and unlocks", () => {
    const table = createTrackTable();
    lockAt(table, 10, 10, CARD_A);
    step(table, [rect(10, 10)], [{ type: "wrong", key: cardKey(CARD_A) }]);
    expect(table.tracks[0].state).toBe("reading");
    expect(table.faceMemory.has(cardKey(CARD_A))).toBe(false);
  });
});

describe("consensus grace", () => {
  it("brief occlusion preserves partial consensus", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)], [], 0);
    const id = table.tracks[0].id;
    // 2 of 3 agreeing reads
    step(table, [rect(10, 10)], [], 100);
    classify(table, id, CARD_A, 100);
    step(table, [rect(10, 10)], [], 200);
    classify(table, id, CARD_A, 200);
    // occlusion past retirement, under CONSENSUS_GRACE_MS
    for (let i = 0; i <= TRACK_RETIRE_FRAMES; i++) {
      step(table, [], [], 300 + i * 100);
    }
    expect(table.tracks).toHaveLength(0);
    // reappears in place within grace: adopts the tally
    step(table, [rect(10, 10)], [], 1500);
    const revived = table.tracks[0];
    expect(revived.state).toBe("reading");
    // ONE more agreeing read completes the 3-run
    step(table, [rect(10, 10)], [], 1600);
    classify(table, revived.id, CARD_A, 1600);
    expect(revived.state).toBe("locked");
  });
});

describe("projectTracks", () => {
  it("projects wire tracks without nulls", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const tracks = projectTracks(table);
    expect(tracks[0]).toEqual({
      trackId: table.tracks[0].id,
      quad: table.tracks[0].quad,
      state: "tentative",
      reading: undefined,
      confidence: undefined,
      provenance: undefined,
    });
  });
});

describe("time-to-all-locked bound", () => {
  it("locks a static 20-card tableau within 60 frames", () => {
    const table = createTrackTable();
    const quads = Array.from({ length: 20 }, (_, i) =>
      rect(20 + (i % 5) * 140, 20 + Math.floor(i / 5) * 120),
    );
    const faces = allCards().slice(0, 20);
    let frames = 0;
    while (
      table.tracks.filter((t) => t.state === "locked").length < 20 &&
      frames < 60
    ) {
      const out = step(table, quads, [], frames * 100);
      const results = out.toClassify.map(({ id }) => {
        const idx = table.tracks.findIndex((t) => t.id === id);
        return { id, outcome: { card: faces[idx], confidence: conf } };
      });
      applyClassifications(table, results, frames * 100);
      frames++;
    }
    expect(frames).toBeLessThan(60); // 6s @ 10fps (spec p50 bound)
  });
});
