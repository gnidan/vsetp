import { describe, expect, test } from "vitest";
import type { Card, FrameAnalysis } from "../model";
import { cardFromKey, cardId, frameId } from "../model";
import type { CardKey } from "../model";
import type { Capture } from "./capture";
import { initialState, reduce } from "./state";

function captureOf(id: number): Capture {
  return {
    frame: {
      id: frameId(id),
      width: 4,
      height: 4,
      pixels: new ArrayBuffer(64),
    },
    displayUrl: `blob:${id}`,
    width: 4,
    height: 4,
    revoke: () => {},
  };
}

function analysisOf(id: number, keys: string[]): FrameAnalysis {
  return {
    frameId: frameId(id),
    frameSize: { width: 4, height: 4 },
    cards: keys.map((key, index) => ({
      id: cardId(index),
      quad: [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 2, y: 2 },
        { x: 1, y: 2 },
      ],
      card: cardFromKey(key as CardKey) as Card,
      confidence: { count: 1, color: 1, shape: 1, fill: 1 },
    })),
    timings: {},
  };
}

const SET_KEYS = ["1-red-oval-solid", "2-red-oval-solid", "3-red-oval-solid"];

describe("reduce", () => {
  test("captured moves idle to analyzing", () => {
    const state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(1),
    });
    expect(state.screen.phase).toBe("analyzing");
  });

  test("matching analysis-ok lands on results with sets selected", () => {
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(1),
    });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(1, SET_KEYS),
    });
    expect(state.screen.phase).toBe("results");
    if (state.screen.phase === "results") {
      expect(state.screen.triples).toHaveLength(1);
      expect(state.screen.selected).toBe(0);
    }
  });

  test("late analysis-ok for a stale frame is ignored", () => {
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(2),
    });
    state = reduce(state, { type: "cancel" });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(2, SET_KEYS),
    });
    expect(state.screen.phase).toBe("idle");
  });

  test("analysis-failed returns to idle with stage guidance", () => {
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(3),
    });
    state = reduce(state, {
      type: "analysis-failed",
      stage: "detect",
      message: "boom",
    });
    expect(state.screen.phase).toBe("idle");
    if (state.screen.phase === "idle") {
      expect(state.screen.notice).toMatch(/in frame|glare/i);
    }
  });

  test("reanalyze returns to analyzing with the same capture", () => {
    const capture = captureOf(4);
    let state = reduce(initialState(), { type: "captured", capture });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(4, SET_KEYS),
    });
    state = reduce(state, { type: "reanalyze" });
    expect(state.screen.phase).toBe("analyzing");
    if (state.screen.phase === "analyzing") {
      expect(state.screen.capture).toBe(capture);
    }
  });

  test("engine events do not disturb the screen", () => {
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(5),
    });
    state = reduce(state, { type: "engine-ready" });
    expect(state.engine.status).toBe("ready");
    expect(state.screen.phase).toBe("analyzing");
  });
});
