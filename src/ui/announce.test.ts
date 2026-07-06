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
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("Some cards are cut off.");
  });

  test("ready idle is quiet", () => {
    const state: AppState = {
      engine: { status: "ready" },
      screen: { phase: "idle", notice: null },
      reveal: "cards",
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
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("Analyzing…");
  });

  // Precedence contract of announcementFor itself: engine text wins
  // over screen text. These two tests pin that from both directions
  // (a ready engine defers to the results text; a loading engine
  // overrides the analyzing text). The dispatch-ordering invariant
  // that keeps app state consistent with this precedence lives in
  // App's onCapture (see the comment there) and is not exercised
  // here — these tests only cover the pure announcement function.
  test("precedence: a ready engine's results screen wins", () => {
    const keys = Array.from({ length: 3 }, () => "1-red-oval-solid");
    const state: AppState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(10),
        analysis: analysisOf(10, keys),
        triples: [],
        selected: -1,
      },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("3 cards read.");
  });

  test("precedence: a loading engine wins over an analyzing screen", () => {
    const state: AppState = {
      engine: { status: "loading", loaded: 1, total: 2 },
      screen: { phase: "analyzing", capture: captureOf(11) },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("Loading card reader… 50%");
  });

  test("sets mode results with sets found reports sets and cards", () => {
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
      reveal: "sets",
    };
    expect(announcementFor(state)).toBe("1 set found. 12 cards read.");
  });

  test("sets mode results with no sets reports card count", () => {
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
      reveal: "sets",
    };
    expect(announcementFor(state)).toBe("No set found among the 8 cards.");
  });

  test("cards mode results reports only the card count", () => {
    const keys = Array.from({ length: 12 }, () => "1-red-oval-solid");
    const state: AppState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(4),
        analysis: analysisOf(4, keys),
        triples: [[cardId(0), cardId(1), cardId(2)]],
        selected: 0,
      },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("12 cards read.");
  });

  test("cards mode singularizes a single card", () => {
    const state: AppState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(9),
        analysis: analysisOf(9, ["1-red-oval-solid"]),
        triples: [],
        selected: -1,
      },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("1 card read.");
  });

  test("presence mode results with a set reports presence", () => {
    const keys = Array.from({ length: 12 }, () => "1-red-oval-solid");
    const state: AppState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(5),
        analysis: analysisOf(5, keys),
        triples: [[cardId(0), cardId(1), cardId(2)]],
        selected: 0,
      },
      reveal: "presence",
    };
    expect(announcementFor(state)).toBe("12 cards read. A set is present.");
  });

  test("presence mode results without a set reports absence", () => {
    const keys = Array.from({ length: 8 }, () => "1-red-oval-solid");
    const state: AppState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(6),
        analysis: analysisOf(6, keys),
        triples: [],
        selected: -1,
      },
      reveal: "presence",
    };
    expect(announcementFor(state)).toBe("8 cards read. No set here.");
  });

  test("cards mode still appends the edge notice", () => {
    const analysis = analysisOf(7, ["1-red-oval-solid", "2-red-oval-solid"]);
    analysis.cards[0].quad = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
      { x: 0, y: 40 },
    ];
    const state: AppState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(7),
        analysis,
        triples: [],
        selected: -1,
      },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe(
      "2 cards read. Some cards are cut off at the edge.",
    );
  });

  test("cards mode with no cards keeps the framing guidance", () => {
    const state: AppState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(8),
        analysis: analysisOf(8, []),
        triples: [],
        selected: -1,
      },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe(
      "No cards detected. Try filling the frame with the spread.",
    );
  });
});
