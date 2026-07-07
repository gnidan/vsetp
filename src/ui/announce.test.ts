import { describe, expect, test } from "vitest";
import type { Card, FrameAnalysis, Track } from "../model";
import { cardFromKey, cardId, frameId, trackId } from "../model";
import type { CardKey } from "../model";
import type { AnalyzedSet } from "../app/highlights";
import type { LiveSet } from "../app/live-sets";
import type { AppState, RevealMode } from "../app/state";
import { initialState } from "../app/state";
import type { SetIdentity } from "../set/identity";
import type { AnnounceState } from "./announce";
import { NO_CARDS_GRACE_MS, announcementFor } from "./announce";

// announcementFor reads only counts; any set shape will do
const SOME_SET: AnalyzedSet = {
  id: "1-red-oval-solid|2-red-oval-solid|3-red-oval-solid" as SetIdentity,
  triple: [cardId(0), cardId(1), cardId(2)],
};

function withEngine(engine: AppState["engine"]): AnnounceState {
  return { ...initialState(), engine, reveal: "cards" };
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
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: {
        phase: "idle",
        notice: "Some cards are cut off.",
        confirmation: null,
      },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("Some cards are cut off.");
  });

  test("ready idle is quiet", () => {
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: { phase: "idle", notice: null, confirmation: null },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("");
  });

  // mode-toggle announcements: leaving live speaks "Still mode."
  // through the idle screen's spoken-only confirmation channel
  test("an idle mode confirmation is announced", () => {
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: { phase: "idle", notice: null, confirmation: "Still mode." },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("Still mode.");
  });

  test("an idle notice and confirmation speak together", () => {
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: {
        phase: "idle",
        notice: "Some cards are cut off.",
        confirmation: "Still mode.",
      },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("Some cards are cut off. Still mode.");
  });

  test("engine failure announces the specific message plus retry", () => {
    expect(
      announcementFor(
        withEngine({
          status: "failed",
          message: "The card reader stopped responding.",
        }),
      ),
    ).toBe("The card reader stopped responding. Use Retry to restart.");
  });

  test("a live stall announces the stall-specific message", () => {
    expect(
      announcementFor(
        withEngine({
          status: "failed",
          message: "The card reader stalled.",
        }),
      ),
    ).toBe("The card reader stalled. Use Retry to restart.");
  });

  test("analyzing phase announces progress", () => {
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: {
        phase: "analyzing",
        capture: captureOf(1),
        carrySelected: null,
      },
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
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(10),
        analysis: analysisOf(10, keys),
        sets: [],
        selected: null,
      },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("3 cards read.");
  });

  test("precedence: a loading engine wins over an analyzing screen", () => {
    const state: AnnounceState = {
      engine: { status: "loading", loaded: 1, total: 2 },
      screen: {
        phase: "analyzing",
        capture: captureOf(11),
        carrySelected: null,
      },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("Loading card reader… 50%");
  });

  test("sets mode results with sets found reports sets and cards", () => {
    const keys = Array.from({ length: 12 }, () => "1-red-oval-solid");
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(2),
        analysis: analysisOf(2, keys),
        sets: [SOME_SET],
        selected: SOME_SET.id,
      },
      reveal: "sets",
    };
    expect(announcementFor(state)).toBe("1 set found. 12 cards read.");
  });

  test("sets mode results with no sets reports card count", () => {
    const keys = Array.from({ length: 8 }, () => "1-red-oval-solid");
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(3),
        analysis: analysisOf(3, keys),
        sets: [],
        selected: null,
      },
      reveal: "sets",
    };
    expect(announcementFor(state)).toBe("No set found among the 8 cards.");
  });

  test("cards mode results reports only the card count", () => {
    const keys = Array.from({ length: 12 }, () => "1-red-oval-solid");
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(4),
        analysis: analysisOf(4, keys),
        sets: [SOME_SET],
        selected: SOME_SET.id,
      },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("12 cards read.");
  });

  test("cards mode singularizes a single card", () => {
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(9),
        analysis: analysisOf(9, ["1-red-oval-solid"]),
        sets: [],
        selected: null,
      },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe("1 card read.");
  });

  test("presence mode results with a set reports presence", () => {
    const keys = Array.from({ length: 12 }, () => "1-red-oval-solid");
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(5),
        analysis: analysisOf(5, keys),
        sets: [SOME_SET],
        selected: SOME_SET.id,
      },
      reveal: "presence",
    };
    expect(announcementFor(state)).toBe("12 cards read. A set is present.");
  });

  test("presence mode results without a set reports absence", () => {
    const keys = Array.from({ length: 8 }, () => "1-red-oval-solid");
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(6),
        analysis: analysisOf(6, keys),
        sets: [],
        selected: null,
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
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(7),
        analysis,
        sets: [],
        selected: null,
      },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe(
      "2 cards read. Some cards are cut off at the edge.",
    );
  });

  test("cards mode with no cards keeps the framing guidance", () => {
    const state: AnnounceState = {
      engine: { status: "ready" },
      screen: {
        phase: "results",
        capture: captureOf(8),
        analysis: analysisOf(8, []),
        sets: [],
        selected: null,
      },
      reveal: "cards",
    };
    expect(announcementFor(state)).toBe(
      "No cards detected. Try filling the frame with the spread.",
    );
  });
});

type LiveScreen = Extract<AppState["screen"], { phase: "live" }>;

function lockedTrack(id: number): Track {
  return {
    trackId: trackId(id),
    quad: [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 8 },
      { x: 0, y: 8 },
    ],
    state: "locked",
    reading: cardFromKey("1-red-oval-solid" as CardKey),
  };
}

const LIVE_SET: LiveSet = {
  id: "1-red-oval-solid|2-red-oval-solid|3-red-oval-solid" as SetIdentity,
  trackIds: [trackId(0), trackId(1), trackId(2)],
};

function liveState(
  over: Partial<LiveScreen> = {},
  reveal: RevealMode = "cards",
): AnnounceState {
  return {
    engine: { status: "ready" },
    screen: {
      phase: "live",
      tracks: [lockedTrack(0)],
      liveSets: [],
      selected: null,
      updatedAt: 1000,
      updateCount: 1,
      presence: { shown: false, candidate: false, streak: 1 },
      lockedCount: 1,
      emptySince: null,
      degraded: false,
      announceTick: 0,
      lastConfirmation: null,
      ...over,
    },
    reveal,
  };
}

describe("announcementFor (live)", () => {
  test("cards reveal reports the locked-card count", () => {
    const state = liveState({
      tracks: [lockedTrack(0), lockedTrack(1), lockedTrack(2)],
      lockedCount: 3,
    });
    expect(announcementFor(state)).toBe("3 cards read.");
  });

  test("cards reveal singularizes one card", () => {
    expect(announcementFor(liveState())).toBe("1 card read.");
  });

  test("presence reveal speaks the DEBOUNCED value, not liveSets", () => {
    // liveSets already has a set but the debounce has not agreed
    // yet: presence must stay silent about it (spoiler parity)
    const state = liveState(
      {
        tracks: [lockedTrack(0), lockedTrack(1), lockedTrack(2)],
        lockedCount: 3,
        liveSets: [LIVE_SET],
        selected: LIVE_SET.id,
        presence: { shown: false, candidate: true, streak: 2 },
      },
      "presence",
    );
    expect(announcementFor(state)).toBe("3 cards read. No set here.");
  });

  test("presence reveal announces a debounced set", () => {
    const state = liveState(
      {
        tracks: [lockedTrack(0), lockedTrack(1), lockedTrack(2)],
        lockedCount: 3,
        liveSets: [LIVE_SET],
        selected: LIVE_SET.id,
        presence: { shown: true, candidate: true, streak: 5 },
      },
      "presence",
    );
    expect(announcementFor(state)).toBe("3 cards read. A set is present.");
  });

  test("sets reveal reports sets and cards", () => {
    const state = liveState(
      {
        tracks: Array.from({ length: 9 }, (_, i) => lockedTrack(i)),
        lockedCount: 9,
        liveSets: [LIVE_SET],
        selected: LIVE_SET.id,
      },
      "sets",
    );
    expect(announcementFor(state)).toBe("1 set found. 9 cards read.");
  });

  test("sets reveal without sets reports the card count", () => {
    const state = liveState(
      {
        tracks: Array.from({ length: 6 }, (_, i) => lockedTrack(i)),
        lockedCount: 6,
      },
      "sets",
    );
    expect(announcementFor(state)).toBe("No set found among the 6 cards.");
  });

  test("zero tracks past the grace period speaks in every mode", () => {
    for (const reveal of ["cards", "presence", "sets"] as const) {
      const state = liveState(
        {
          tracks: [],
          lockedCount: 0,
          emptySince: 0,
          updatedAt: NO_CARDS_GRACE_MS,
        },
        reveal,
      );
      expect(announcementFor(state)).toBe("No cards in view.");
    }
  });

  test("zero tracks within the grace period stays quiet", () => {
    const state = liveState({
      tracks: [],
      lockedCount: 0,
      emptySince: 0,
      updatedAt: NO_CARDS_GRACE_MS - 1,
    });
    expect(announcementFor(state)).toBe("");
  });

  test("tracks present but none locked stays quiet", () => {
    const tentative: Track = { ...lockedTrack(0), state: "tentative" };
    const state = liveState({ tracks: [tentative], lockedCount: 0 });
    expect(announcementFor(state)).toBe("");
  });

  test("strings are stable across updatedAt/updateCount churn", () => {
    for (const reveal of ["cards", "presence", "sets"] as const) {
      const screen: Partial<LiveScreen> = {
        tracks: [lockedTrack(0), lockedTrack(1), lockedTrack(2)],
        lockedCount: 3,
        liveSets: [LIVE_SET],
        selected: LIVE_SET.id,
        presence: { shown: true, candidate: true, streak: 7 },
      };
      const before = liveState(
        { ...screen, updatedAt: 5000, updateCount: 41 },
        reveal,
      );
      const after = liveState(
        { ...screen, updatedAt: 5033, updateCount: 42 },
        reveal,
      );
      expect(announcementFor(after)).toBe(announcementFor(before));
    }
  });

  test("odd announce ticks re-speak no-cards via an invisible suffix", () => {
    const empty: Partial<LiveScreen> = {
      tracks: [],
      lockedCount: 0,
      emptySince: 0,
      updatedAt: NO_CARDS_GRACE_MS,
    };
    const even = announcementFor(liveState({ ...empty, announceTick: 2 }));
    const odd = announcementFor(liveState({ ...empty, announceTick: 3 }));
    expect(even).toBe("No cards in view.");
    expect(odd).toBe("No cards in view.\u00a0");
  });

  test("announce ticks never disturb a non-empty announcement", () => {
    const state = liveState({ announceTick: 5 });
    expect(announcementFor(state)).toBe("1 card read.");
  });

  test("no-cards message is stable across further churn too", () => {
    const screen: Partial<LiveScreen> = {
      tracks: [],
      lockedCount: 0,
      emptySince: 0,
    };
    const before = liveState({
      ...screen,
      updatedAt: NO_CARDS_GRACE_MS + 100,
      updateCount: 41,
    });
    const after = liveState({
      ...screen,
      updatedAt: NO_CARDS_GRACE_MS + 133,
      updateCount: 42,
    });
    expect(announcementFor(before)).toBe("No cards in view.");
    expect(announcementFor(after)).toBe(announcementFor(before));
  });

  // mode-toggle announcements: live-entered seeds lastConfirmation
  // (see state.ts), so a fresh live entry speaks "Live mode."
  test("a fresh live entry announces Live mode", () => {
    const state = liveState({
      tracks: [],
      lockedCount: 0,
      updatedAt: null,
      updateCount: 0,
      lastConfirmation: "Live mode.",
    });
    expect(announcementFor(state)).toBe("Live mode.");
  });

  test("a mark confirmation is appended to the live summary", () => {
    const state = liveState({ lastConfirmation: "Marked correct." });
    expect(announcementFor(state)).toBe("1 card read. Marked correct.");
  });

  test("a mark confirmation speaks alone while the view is quiet", () => {
    const state = liveState({
      tracks: [],
      lockedCount: 0,
      lastConfirmation: "Marked wrong reading.",
    });
    expect(announcementFor(state)).toBe("Marked wrong reading.");
  });

  test("a mark confirmation joins the no-cards guidance", () => {
    const state = liveState({
      tracks: [],
      lockedCount: 0,
      emptySince: 0,
      updatedAt: NO_CARDS_GRACE_MS,
      lastConfirmation: "Looking for a card there.",
    });
    expect(announcementFor(state)).toBe(
      "No cards in view. Looking for a card there.",
    );
  });
});
