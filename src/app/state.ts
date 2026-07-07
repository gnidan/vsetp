import type { FrameAnalysis, FrameId, Track } from "../model";
import type { SetIdentity } from "../set/identity";
import type { PipelineStage } from "../worker/protocol";
import type { AnalyzedSet } from "./highlights";
import type { Capture } from "./capture";
import type { LiveSet } from "./live-sets";
import { guidanceFor } from "./guidance";
import { findSetsInAnalysis } from "./highlights";
import { liveSetsOf } from "./live-sets";

// Consecutive live updates that must agree before the displayed
// presence signal flips (spec: presence debounce).
export const PRESENCE_DEBOUNCE_UPDATES = 5;

export type EngineState =
  | { status: "cold" }
  | { status: "loading"; loaded: number; total: number | null }
  | { status: "ready" }
  | { status: "failed"; message: string };

export type Screen =
  | {
      phase: "idle";
      notice: string | null;
      // transient spoken-only confirmation ("Still mode."), appended
      // to the aria announcement, never rendered visually; replaced
      // by the next screen transition
      confirmation: string | null;
    }
  | {
      phase: "analyzing";
      capture: Capture;
      // selection carried across a reanalyze of the same capture;
      // null for a fresh capture (spec: reanalyze keeps the selected
      // identity when the new result still contains it)
      carrySelected: SetIdentity | null;
    }
  | {
      phase: "results";
      capture: Capture;
      analysis: FrameAnalysis;
      sets: AnalyzedSet[];
      selected: SetIdentity | null;
    }
  | {
      phase: "live";
      tracks: Track[];
      liveSets: LiveSet[];
      selected: SetIdentity | null;
      updatedAt: number | null; // last live-update wall ms
      updateCount: number;
      presence: {
        // debounced derived signal
        shown: boolean; // what presence mode displays
        candidate: boolean;
        streak: number; // consecutive updates agreeing
      };
      lockedCount: number;
      emptySince: number | null; // wall ms of zero-track start
      degraded: boolean; // adaptation ladder below 768
      // slow-cadence re-announce counter for the empty live view;
      // bumped by Session's nudge timer (see announcementFor)
      announceTick: number;
      // transient feedback confirmation ("Marked correct." etc.),
      // appended to the live announcement and cleared by the next
      // live update
      lastConfirmation: string | null;
    };

// Graduated spoiler ladder: what the results screen may disclose.
// Session-sticky — the STATE lives in App, above the keyed Session
// (spec: retry replaces Session while the camera, mode, reveal, and
// FeedbackLog persist), so it is not a reducer field; components and
// announcementFor receive it alongside AppState.
export type RevealMode = "cards" | "presence" | "sets";

export interface AppState {
  engine: EngineState;
  screen: Screen;
}

export type AppEvent =
  | { type: "engine-progress"; loaded: number; total: number | null }
  | { type: "engine-ready" }
  | { type: "engine-failed"; message: string }
  | { type: "captured"; capture: Capture }
  | { type: "analysis-ok"; analysis: FrameAnalysis }
  | { type: "analysis-superseded"; frameId: FrameId }
  | { type: "analysis-failed"; stage: PipelineStage; message: string }
  | { type: "capture-failed"; message: string }
  | { type: "cancel" }
  | { type: "retake" }
  | { type: "reanalyze" }
  | { type: "select-set"; id: SetIdentity }
  | { type: "live-entered"; at: number }
  | { type: "live-update-received"; tracks: Track[]; at: number }
  // notice: a visible idle banner (e.g. the cancel-then-live
  // fallback); confirmation: a spoken-only transient ("Still mode.")
  | { type: "live-left"; notice?: string | null; confirmation?: string | null }
  | { type: "live-degraded"; degraded: boolean }
  | { type: "live-nudge" }
  | { type: "mark-confirmed"; text: string };

export function initialState(): AppState {
  return {
    engine: { status: "cold" },
    screen: { phase: "idle", notice: null, confirmation: null },
  };
}

function reduceScreen(screen: Screen, event: AppEvent): Screen {
  switch (event.type) {
    case "captured":
      return {
        phase: "analyzing",
        capture: event.capture,
        carrySelected: null,
      };
    case "analysis-ok": {
      if (
        screen.phase !== "analyzing" ||
        screen.capture.frame.id !== event.analysis.frameId
      ) {
        return screen; // stale result: a cancel/re-capture won
      }
      const { sets } = findSetsInAnalysis(event.analysis);
      const carried = screen.carrySelected;
      const selected =
        carried !== null && sets.some((set) => set.id === carried)
          ? carried
          : (sets[0]?.id ?? null);
      return {
        phase: "results",
        capture: screen.capture,
        analysis: event.analysis,
        sets,
        selected,
      };
    }
    case "analysis-superseded":
      return screen; // a newer frame's result is coming
    case "analysis-failed":
      if (screen.phase !== "analyzing") return screen;
      return {
        phase: "idle",
        notice: guidanceFor(event.stage),
        confirmation: null,
      };
    case "capture-failed":
      // live has no capture affordance; a stray failure (e.g. a
      // stale still-capture rejection) must not tear the phase down
      return screen.phase === "live"
        ? screen
        : { phase: "idle", notice: event.message, confirmation: null };
    case "cancel":
      return screen.phase === "analyzing"
        ? { phase: "idle", notice: null, confirmation: null }
        : screen;
    case "retake":
      return screen.phase === "results"
        ? { phase: "idle", notice: null, confirmation: null }
        : screen;
    case "reanalyze":
      return screen.phase === "results"
        ? {
            phase: "analyzing",
            capture: screen.capture,
            carrySelected: screen.selected,
          }
        : screen;
    case "select-set":
      return screen.phase === "results" || screen.phase === "live"
        ? { ...screen, selected: event.id }
        : screen;
    case "live-entered":
      return screen.phase === "idle"
        ? {
            phase: "live",
            tracks: [],
            liveSets: [],
            selected: null,
            updatedAt: null,
            updateCount: 0,
            presence: { shown: false, candidate: false, streak: 0 },
            lockedCount: 0,
            emptySince: event.at,
            degraded: false,
            announceTick: 0,
            // mode transitions must speak ("Live mode."): entering
            // live seeds the transient-confirmation channel, which
            // the first live update then clears (value-stable text)
            lastConfirmation: "Live mode.",
          }
        : screen;
    case "live-update-received": {
      if (screen.phase !== "live") return screen;
      const liveSets = liveSetsOf(event.tracks);
      const selected =
        screen.selected !== null &&
        liveSets.some((set) => set.id === screen.selected)
          ? screen.selected
          : (liveSets[0]?.id ?? null);
      // presence debounce: the displayed signal flips only after
      // PRESENCE_DEBOUNCE_UPDATES consecutive updates agree
      const candidate = liveSets.length > 0;
      const streak =
        candidate === screen.presence.candidate
          ? screen.presence.streak + 1
          : 1;
      const shown =
        streak >= PRESENCE_DEBOUNCE_UPDATES &&
        candidate !== screen.presence.shown
          ? candidate
          : screen.presence.shown;
      return {
        ...screen,
        tracks: event.tracks,
        liveSets,
        selected,
        updatedAt: event.at,
        updateCount: screen.updateCount + 1,
        presence: { shown, candidate, streak },
        lockedCount: event.tracks.filter((track) => track.state === "locked")
          .length,
        emptySince:
          event.tracks.length > 0 ? null : (screen.emptySince ?? event.at),
        // confirmations are one-update transients: the next live
        // render sweep clears them
        lastConfirmation: null,
      };
    }
    case "live-left":
      return screen.phase === "live"
        ? {
            phase: "idle",
            notice: event.notice ?? null,
            confirmation: event.confirmation ?? null,
          }
        : screen;
    case "live-degraded":
      return screen.phase === "live"
        ? { ...screen, degraded: event.degraded }
        : screen;
    case "live-nudge":
      return screen.phase === "live"
        ? { ...screen, announceTick: screen.announceTick + 1 }
        : screen;
    case "mark-confirmed":
      return screen.phase === "live"
        ? { ...screen, lastConfirmation: event.text }
        : screen;
    default:
      return screen;
  }
}

function reduceEngine(engine: EngineState, event: AppEvent): EngineState {
  switch (event.type) {
    case "engine-progress":
      return { status: "loading", loaded: event.loaded, total: event.total };
    case "engine-ready":
      return { status: "ready" };
    case "engine-failed":
      return { status: "failed", message: event.message };
    default:
      return engine;
  }
}

export function reduce(state: AppState, event: AppEvent): AppState {
  return {
    engine: reduceEngine(state.engine, event),
    screen: reduceScreen(state.screen, event),
  };
}
