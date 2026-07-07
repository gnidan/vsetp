import { describe, expect, test } from "vitest";
import type { Card, FrameAnalysis, Track, TrackState } from "../model";
import { cardFromKey, cardId, frameId, trackId } from "../model";
import type { CardKey } from "../model";
import type { SetIdentity } from "../set/identity";
import type { Capture } from "./capture";
import type { AppState } from "./state";
import { PRESENCE_DEBOUNCE_UPDATES, initialState, reduce } from "./state";

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
const OTHER_SET_KEYS = [
  "1-green-diamond-open",
  "2-green-diamond-open",
  "3-green-diamond-open",
];
const SET_ID = SET_KEYS.join("|") as SetIdentity;
const OTHER_SET_ID = OTHER_SET_KEYS.join("|") as SetIdentity;

describe("reduce", () => {
  test("captured moves idle to analyzing", () => {
    const state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(1),
    });
    expect(state.screen.phase).toBe("analyzing");
  });

  test("matching analysis-ok lands on results with first set selected", () => {
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
      expect(state.screen.sets).toHaveLength(1);
      expect(state.screen.sets[0].id).toBe(SET_ID);
      expect(state.screen.selected).toBe(SET_ID);
    }
  });

  test("analysis-ok with no sets selects null", () => {
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(1),
    });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(1, ["1-red-oval-solid"]),
    });
    expect(state.screen.phase).toBe("results");
    if (state.screen.phase === "results") {
      expect(state.screen.sets).toEqual([]);
      expect(state.screen.selected).toBeNull();
    }
  });

  test("select-set by identity round-trips", () => {
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(1),
    });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(1, [...SET_KEYS, ...OTHER_SET_KEYS]),
    });
    expect(state.screen.phase).toBe("results");
    if (state.screen.phase === "results") {
      expect(state.screen.sets.map((s) => s.id)).toEqual([
        SET_ID,
        OTHER_SET_ID,
      ]);
      expect(state.screen.selected).toBe(SET_ID);
    }
    state = reduce(state, { type: "select-set", id: OTHER_SET_ID });
    if (state.screen.phase === "results") {
      expect(state.screen.selected).toBe(OTHER_SET_ID);
    }
  });

  test("selecting a disambiguated (suffixed) identity round-trips", () => {
    // a duplicated face key yields two sets colliding on the raw
    // identity; the second is suffixed #2 (see highlights.ts)
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(1),
    });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(1, ["1-red-oval-solid", ...SET_KEYS]),
    });
    const suffixed = `${SET_ID}#2` as SetIdentity;
    expect(state.screen.phase).toBe("results");
    if (state.screen.phase === "results") {
      expect(state.screen.sets.map((s) => s.id)).toEqual([SET_ID, suffixed]);
    }
    state = reduce(state, { type: "select-set", id: suffixed });
    if (state.screen.phase === "results") {
      expect(state.screen.selected).toBe(suffixed);
    }
  });

  test("reanalyze keeps a selection whose identity survives", () => {
    const capture = captureOf(4);
    let state = reduce(initialState(), { type: "captured", capture });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(4, [...SET_KEYS, ...OTHER_SET_KEYS]),
    });
    state = reduce(state, { type: "select-set", id: OTHER_SET_ID });
    state = reduce(state, { type: "reanalyze" });
    expect(state.screen.phase).toBe("analyzing");
    // same set survives even though ids/order shifted
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(4, [...OTHER_SET_KEYS, ...SET_KEYS]),
    });
    expect(state.screen.phase).toBe("results");
    if (state.screen.phase === "results") {
      expect(state.screen.selected).toBe(OTHER_SET_ID);
    }
  });

  test("reanalyze losing the selected identity falls back to first", () => {
    const capture = captureOf(4);
    let state = reduce(initialState(), { type: "captured", capture });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(4, [...SET_KEYS, ...OTHER_SET_KEYS]),
    });
    state = reduce(state, { type: "select-set", id: OTHER_SET_ID });
    state = reduce(state, { type: "reanalyze" });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(4, SET_KEYS),
    });
    expect(state.screen.phase).toBe("results");
    if (state.screen.phase === "results") {
      expect(state.screen.selected).toBe(SET_ID);
    }
  });

  test("reanalyze losing all sets falls back to null", () => {
    const capture = captureOf(4);
    let state = reduce(initialState(), { type: "captured", capture });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(4, SET_KEYS),
    });
    state = reduce(state, { type: "reanalyze" });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(4, ["1-red-oval-solid"]),
    });
    expect(state.screen.phase).toBe("results");
    if (state.screen.phase === "results") {
      expect(state.screen.selected).toBeNull();
    }
  });

  test("a fresh capture does not carry the previous selection", () => {
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(1),
    });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(1, [...SET_KEYS, ...OTHER_SET_KEYS]),
    });
    state = reduce(state, { type: "select-set", id: OTHER_SET_ID });
    state = reduce(state, { type: "retake" });
    state = reduce(state, { type: "captured", capture: captureOf(2) });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(2, [...SET_KEYS, ...OTHER_SET_KEYS]),
    });
    expect(state.screen.phase).toBe("results");
    if (state.screen.phase === "results") {
      expect(state.screen.selected).toBe(SET_ID);
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

  test("reveal defaults to cards", () => {
    expect(initialState().reveal).toBe("cards");
  });

  test("set-reveal switches the reveal mode", () => {
    const state = reduce(initialState(), {
      type: "set-reveal",
      mode: "presence",
    });
    expect(state.reveal).toBe("presence");
  });

  test("reveal survives retake", () => {
    let state = reduce(initialState(), { type: "set-reveal", mode: "sets" });
    state = reduce(state, { type: "captured", capture: captureOf(6) });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(6, SET_KEYS),
    });
    state = reduce(state, { type: "retake" });
    expect(state.screen.phase).toBe("idle");
    expect(state.reveal).toBe("sets");
  });

  test("reveal survives reanalyze", () => {
    let state = reduce(initialState(), {
      type: "set-reveal",
      mode: "presence",
    });
    state = reduce(state, { type: "captured", capture: captureOf(7) });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(7, SET_KEYS),
    });
    state = reduce(state, { type: "reanalyze" });
    expect(state.screen.phase).toBe("analyzing");
    expect(state.reveal).toBe("presence");
  });

  test("set-reveal does not disturb the screen", () => {
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(8),
    });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(8, SET_KEYS),
    });
    state = reduce(state, { type: "set-reveal", mode: "sets" });
    expect(state.screen.phase).toBe("results");
  });
});

function trackOf(
  id: number,
  key: string | null,
  state: TrackState = "locked",
): Track {
  const base = id * 10;
  return {
    trackId: trackId(id),
    quad: [
      { x: base, y: 0 },
      { x: base + 5, y: 0 },
      { x: base + 5, y: 8 },
      { x: base, y: 8 },
    ],
    state,
    ...(key === null ? {} : { reading: cardFromKey(key as CardKey) }),
  };
}

const SET_TRACKS = SET_KEYS.map((key, i) => trackOf(i, key));
const OTHER_SET_TRACKS = OTHER_SET_KEYS.map((key, i) => trackOf(i + 3, key));

function liveState(at = 0): AppState {
  return reduce(initialState(), { type: "live-entered", at });
}

function updated(state: AppState, tracks: Track[], at = 1): AppState {
  return reduce(state, { type: "live-update-received", tracks, at });
}

// assert-and-narrow: vacuous-guard-proof access to the live screen
function live(state: AppState): Extract<AppState["screen"], { phase: "live" }> {
  const { screen } = state;
  if (screen.phase !== "live") {
    throw new Error(`expected live phase, got ${screen.phase}`);
  }
  return screen;
}

describe("reduce (live phase)", () => {
  test("live-entered from idle starts a fresh live screen", () => {
    const state = liveState(100);
    expect(state.screen).toEqual({
      phase: "live",
      tracks: [],
      liveSets: [],
      selected: null,
      updatedAt: null,
      updateCount: 0,
      presence: { shown: false, candidate: false, streak: 0 },
      lockedCount: 0,
      emptySince: 100,
      degraded: false,
      announceTick: 0,
    });
  });

  test("live-entered outside idle is ignored", () => {
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(1),
    });
    state = reduce(state, { type: "live-entered", at: 5 });
    expect(state.screen.phase).toBe("analyzing");
  });

  test("live-update-received recomputes sets, counts, and clock", () => {
    const screen = live(updated(liveState(), SET_TRACKS, 250));
    expect(screen.liveSets.map((s) => s.id)).toEqual([SET_ID]);
    expect(screen.selected).toBe(SET_ID);
    expect(screen.lockedCount).toBe(3);
    expect(screen.updatedAt).toBe(250);
    expect(screen.updateCount).toBe(1);
  });

  test("live-update-received outside live is ignored", () => {
    const state = reduce(initialState(), {
      type: "live-update-received",
      tracks: SET_TRACKS,
      at: 1,
    });
    expect(state.screen.phase).toBe("idle");
  });

  test("lockedCount counts only locked tracks", () => {
    const screen = live(
      updated(liveState(), [
        trackOf(0, SET_KEYS[0]),
        trackOf(1, SET_KEYS[1], "reading"),
        trackOf(2, SET_KEYS[2], "uncertain-locked"),
        trackOf(3, null, "tentative"),
      ]),
    );
    expect(screen.lockedCount).toBe(1);
  });

  test("selection keeps its identity while it survives updates", () => {
    let state = updated(liveState(), [...SET_TRACKS, ...OTHER_SET_TRACKS], 1);
    state = reduce(state, { type: "select-set", id: OTHER_SET_ID });
    expect(live(state).selected).toBe(OTHER_SET_ID);
    state = updated(state, [...OTHER_SET_TRACKS, ...SET_TRACKS], 2);
    expect(live(state).selected).toBe(OTHER_SET_ID);
  });

  test("selection lost falls back to first, then null", () => {
    let state = updated(liveState(), [...SET_TRACKS, ...OTHER_SET_TRACKS], 1);
    state = reduce(state, { type: "select-set", id: OTHER_SET_ID });
    state = updated(state, SET_TRACKS, 2);
    expect(live(state).selected).toBe(SET_ID);
    state = updated(state, [], 3);
    expect(live(state).selected).toBeNull();
  });

  test("presence shows only after the debounce streak agrees", () => {
    let state = liveState();
    for (let i = 1; i < PRESENCE_DEBOUNCE_UPDATES; i++) {
      state = updated(state, SET_TRACKS, i);
      expect(live(state).presence).toEqual({
        shown: false,
        candidate: true,
        streak: i,
      });
    }
    state = updated(state, SET_TRACKS, PRESENCE_DEBOUNCE_UPDATES);
    expect(live(state).presence).toEqual({
      shown: true,
      candidate: true,
      streak: PRESENCE_DEBOUNCE_UPDATES,
    });
  });

  test("a flicker resets the streak without flipping shown", () => {
    let state = liveState();
    for (let i = 1; i < PRESENCE_DEBOUNCE_UPDATES; i++) {
      state = updated(state, SET_TRACKS, i);
    }
    state = updated(state, [], PRESENCE_DEBOUNCE_UPDATES);
    expect(live(state).presence).toEqual({
      shown: false,
      candidate: false,
      streak: 1,
    });
  });

  test("agreement with what is shown never flips it", () => {
    let state = liveState();
    for (let i = 1; i <= PRESENCE_DEBOUNCE_UPDATES + 2; i++) {
      state = updated(state, [], i);
      expect(live(state).presence.shown).toBe(false);
    }
  });

  test("shown flips back after a full absent streak", () => {
    let state = liveState();
    for (let i = 1; i <= PRESENCE_DEBOUNCE_UPDATES; i++) {
      state = updated(state, SET_TRACKS, i);
    }
    for (let i = 1; i <= PRESENCE_DEBOUNCE_UPDATES; i++) {
      state = updated(state, [], PRESENCE_DEBOUNCE_UPDATES + i);
      expect(live(state).presence.shown).toBe(i < PRESENCE_DEBOUNCE_UPDATES);
    }
  });

  test("emptySince keeps the earliest zero-track timestamp", () => {
    let state = liveState(10);
    state = updated(state, [], 20);
    expect(live(state).emptySince).toBe(10);
    state = updated(state, SET_TRACKS, 30);
    expect(live(state).emptySince).toBeNull();
    state = updated(state, [], 40);
    state = updated(state, [], 50);
    expect(live(state).emptySince).toBe(40);
  });

  test("live-left returns to a clean idle", () => {
    const state = reduce(liveState(), { type: "live-left" });
    expect(state.screen).toEqual({ phase: "idle", notice: null });
  });

  test("live-left outside live is ignored", () => {
    const state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(1),
    });
    expect(reduce(state, { type: "live-left" }).screen.phase).toBe("analyzing");
  });

  test("live-degraded toggles the flag in live only", () => {
    let state = reduce(liveState(), { type: "live-degraded", degraded: true });
    expect(live(state).degraded).toBe(true);
    state = reduce(state, { type: "live-degraded", degraded: false });
    expect(live(state).degraded).toBe(false);
    const idle = reduce(initialState(), {
      type: "live-degraded",
      degraded: true,
    });
    expect(idle.screen).toEqual({ phase: "idle", notice: null });
  });

  test("live-nudge bumps the announce tick in live only", () => {
    let state = reduce(liveState(), { type: "live-nudge" });
    expect(live(state).announceTick).toBe(1);
    state = reduce(state, { type: "live-nudge" });
    expect(live(state).announceTick).toBe(2);
    const idle = reduce(initialState(), { type: "live-nudge" });
    expect(idle.screen).toEqual({ phase: "idle", notice: null });
  });

  test("a live update does not reset the announce tick", () => {
    let state = reduce(liveState(), { type: "live-nudge" });
    state = updated(state, SET_TRACKS, 50);
    expect(live(state).announceTick).toBe(1);
  });

  test("capture-failed is ignored during live", () => {
    const state = reduce(liveState(), {
      type: "capture-failed",
      message: "nope",
    });
    expect(state.screen.phase).toBe("live");
  });

  test("capture-failed lands idle with the message otherwise", () => {
    const state = reduce(initialState(), {
      type: "capture-failed",
      message: "nope",
    });
    expect(state.screen).toEqual({ phase: "idle", notice: "nope" });
  });

  test("captured transitions live to analyzing (total reducer)", () => {
    const state = reduce(liveState(), {
      type: "captured",
      capture: captureOf(9),
    });
    expect(state.screen.phase).toBe("analyzing");
  });

  test("reveal is untouched by live transitions", () => {
    let state = reduce(initialState(), { type: "set-reveal", mode: "sets" });
    state = reduce(state, { type: "live-entered", at: 0 });
    state = updated(state, SET_TRACKS, 1);
    state = reduce(state, { type: "live-left" });
    expect(state.reveal).toBe("sets");
  });
});
