import { describe, expect, test } from "vitest";
import type { Card, FrameAnalysis } from "../model";
import { cardFromKey, cardId, frameId } from "../model";
import type { CardKey } from "../model";
import type { AppState } from "../app/state";
import { initialState } from "../app/state";
import { announcementFor } from "./announce";

function withEngine(engine: AppState["engine"]): AppState {
  return { ...initialState(), engine };
}

function captureOf(id: number) {
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
    frameSize: { width: 100, height: 100 },
    cards: keys.map((key, index) => ({
      id: cardId(index),
      quad: [
        { x: 20, y: 20 },
        { x: 40, y: 20 },
        { x: 40, y: 40 },
        { x: 20, y: 40 },
      ],
      card: cardFromKey(key as CardKey) as Card,
      confidence: { count: 1, color: 1, shape: 1, fill: 1 },
    })),
    timings: {},
  };
}

describe("announcementFor", () => {
  test("engine loading with total reports percent", () => {
    expect(
      announcementFor(
        withEngine({ status: "loading", loaded: 42, total: 100 }),
      ),
    ).toBe("Loading card reader… 42%");
  });

  test("engine loading without total reports megabytes", () => {
    expect(
      announcementFor(
        withEngine({
          status: "loading",
          loaded: 5 * 1024 * 1024,
          total: null,
        }),
      ),
    ).toBe("Loading card reader… 5MB");
  });

  test("idle notice is announced", () => {
    const state: AppState = {
      engine: { status: "ready" },
      screen: { phase: "idle", notice: "Some cards are cut off." },
    };
    expect(announcementFor(state)).toBe("Some cards are cut off.");
  });

  test("ready idle is quiet", () => {
    const state: AppState = {
      engine: { status: "ready" },
      screen: { phase: "idle", notice: null },
    };
    expect(announcementFor(state)).toBe("");
  });

  test("engine failure announces the failure copy", () => {
    expect(
      announcementFor(withEngine({ status: "failed", message: "x" })),
    ).toMatch(/card reader/i);
  });

  test("analyzing phase announces progress", () => {
    const state: AppState = {
      engine: { status: "ready" },
      screen: { phase: "analyzing", capture: captureOf(1) },
    };
    expect(announcementFor(state)).toBe("Analyzing…");
  });

  test("results with sets found reports sets and card count", () => {
    const keys = Array.from({ length: 12 }, () => "1-red-oval-solid");
    const state: AppState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(2),
        analysis: analysisOf(2, keys),
        triples: [[cardId(0), cardId(1), cardId(2)]],
        selected: 0,
      },
    };
    expect(announcementFor(state)).toBe("1 set found. 12 cards read.");
  });

  test("results with no sets reports card count", () => {
    const keys = Array.from({ length: 8 }, () => "1-red-oval-solid");
    const state: AppState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(3),
        analysis: analysisOf(3, keys),
        triples: [],
        selected: -1,
      },
    };
    expect(announcementFor(state)).toBe("No set found among the 8 cards.");
  });
});
