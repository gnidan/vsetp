import { describe, expect, test } from "vitest";
import type { CardKey, Mark, Track } from "../model";
import { trackId } from "../model";
import {
  FACE_RADIUS,
  createFeedbackLog,
  createRoiOutcomeReporter,
} from "./feedback-log";

const KEY = "1-red-oval-solid" as CardKey;

function missedAt(x: number, y: number): Mark {
  return { type: "missed-card", at: { x, y } };
}

function roiTrackAt(id: number, x: number, y: number): Track {
  return {
    trackId: trackId(id),
    quad: [
      { x: x - 1, y: y - 1 },
      { x: x + 1, y: y - 1 },
      { x: x + 1, y: y + 1 },
      { x: x - 1, y: y + 1 },
    ],
    state: "tentative",
    provenance: "roi-assist",
  };
}

function plainTrackAt(id: number, x: number, y: number): Track {
  const { provenance: _, ...track } = roiTrackAt(id, x, y);
  return track;
}

describe("createFeedbackLog", () => {
  test("record appends entries in order with timestamps", () => {
    const log = createFeedbackLog();
    log.record({ type: "correct", key: KEY }, 10);
    log.record(missedAt(50, 60), 20);
    expect(log.entries()).toEqual([
      { at: 10, mark: { type: "correct", key: KEY } },
      { at: 20, mark: missedAt(50, 60) },
    ]);
  });

  test("entries() is a snapshot: mutating it never touches the log", () => {
    const log = createFeedbackLog();
    log.record(missedAt(1, 2), 1);
    log.entries().pop();
    expect(log.entries()).toHaveLength(1);
  });

  test("noteRoiFound resolves the MOST RECENT unresolved missed-card", () => {
    const log = createFeedbackLog();
    log.record(missedAt(100, 100), 1);
    log.record(missedAt(110, 100), 2);
    log.noteRoiFound({ x: 105, y: 100 }, 3);
    expect(log.entries()).toEqual([
      { at: 1, mark: missedAt(100, 100) },
      { at: 2, mark: missedAt(110, 100), outcome: "roi-found", resolvedAt: 3 },
    ]);
    // a second DISTINCT find (the caller dedupes per track — see
    // createRoiOutcomeReporter) resolves the remaining entry
    log.noteRoiFound({ x: 105, y: 100 }, 4);
    expect(log.entries()[0]).toEqual({
      at: 1,
      mark: missedAt(100, 100),
      outcome: "roi-found",
      resolvedAt: 4,
    });
  });

  test("noteRoiFound ignores marks outside FACE_RADIUS", () => {
    const log = createFeedbackLog();
    log.record(missedAt(0, 0), 1);
    log.noteRoiFound({ x: FACE_RADIUS + 1, y: 0 }, 2);
    expect(log.entries()[0].outcome).toBeUndefined();
    log.noteRoiFound({ x: FACE_RADIUS, y: 0 }, 3); // boundary inclusive
    expect(log.entries()[0].outcome).toBe("roi-found");
  });

  test("noteRoiFound never touches non-missed or resolved entries", () => {
    const log = createFeedbackLog();
    log.record({ type: "not-a-card", at: { x: 5, y: 5 } }, 1);
    log.record({ type: "wrong", key: KEY }, 2);
    log.noteRoiFound({ x: 5, y: 5 }, 3);
    expect(log.entries().every((entry) => entry.outcome === undefined)).toBe(
      true,
    );
  });

  test("toJson emits { marks: [...] }", () => {
    const log = createFeedbackLog();
    log.record(missedAt(9, 8), 7);
    log.noteRoiFound({ x: 9, y: 8 }, 11);
    expect(JSON.parse(log.toJson())).toEqual({
      marks: [
        {
          at: 7,
          mark: { type: "missed-card", at: { x: 9, y: 8 } },
          outcome: "roi-found",
          resolvedAt: 11,
        },
      ],
    });
  });
});

describe("createRoiOutcomeReporter", () => {
  test("first sight of a roi-assist track resolves a mark", () => {
    const log = createFeedbackLog();
    const report = createRoiOutcomeReporter(log);
    log.record(missedAt(100, 100), 1);
    report([roiTrackAt(7, 102, 100)], 2);
    expect(log.entries()[0].outcome).toBe("roi-found");
  });

  test("a track's later updates never resolve a LATER mark", () => {
    // a roi-assist track keeps its provenance for its lifetime; only
    // its FIRST appearance is an outcome. Without the dedupe, the
    // persisting track would falsely resolve this second mark.
    const log = createFeedbackLog();
    const report = createRoiOutcomeReporter(log);
    log.record(missedAt(100, 100), 1);
    report([roiTrackAt(7, 102, 100)], 2); // resolves mark 1
    log.record(missedAt(110, 100), 3); // a NEW nearby mark
    report([roiTrackAt(7, 102, 100)], 4); // same track, next update
    expect(log.entries()[1].outcome).toBeUndefined();
  });

  test("a NEW roi-assist track may still resolve", () => {
    const log = createFeedbackLog();
    const report = createRoiOutcomeReporter(log);
    log.record(missedAt(100, 100), 1);
    log.record(missedAt(110, 100), 2);
    report([roiTrackAt(7, 102, 100)], 3);
    report([roiTrackAt(8, 108, 100), roiTrackAt(7, 102, 100)], 4);
    expect(log.entries().every((entry) => entry.outcome === "roi-found")).toBe(
      true,
    );
  });

  test("tracks without roi-assist provenance are ignored", () => {
    const log = createFeedbackLog();
    const report = createRoiOutcomeReporter(log);
    log.record(missedAt(100, 100), 1);
    report([plainTrackAt(7, 100, 100)], 2);
    expect(log.entries()[0].outcome).toBeUndefined();
  });
});
