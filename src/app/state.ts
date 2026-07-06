import type { FrameAnalysis, FrameId } from "../model";
import type { SetTriple } from "../set";
import type { PipelineStage } from "../worker/protocol";
import type { Capture } from "./capture";
import { guidanceFor } from "./guidance";
import { findSetsInAnalysis } from "./highlights";

export type EngineState =
  | { status: "cold" }
  | { status: "loading"; loaded: number; total: number | null }
  | { status: "ready" }
  | { status: "failed"; message: string };

export type Screen =
  | { phase: "idle"; notice: string | null }
  | { phase: "analyzing"; capture: Capture }
  | {
      phase: "results";
      capture: Capture;
      analysis: FrameAnalysis;
      triples: SetTriple[];
      selected: number;
    };

// Graduated spoiler ladder: what the results screen may disclose.
// Session-sticky — never reset by screen transitions.
export type RevealMode = "cards" | "presence" | "sets";

export interface AppState {
  engine: EngineState;
  screen: Screen;
  reveal: RevealMode;
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
  | { type: "select-set"; index: number }
  | { type: "set-reveal"; mode: RevealMode };

export function initialState(): AppState {
  return {
    engine: { status: "cold" },
    screen: { phase: "idle", notice: null },
    reveal: "cards",
  };
}

function reduceScreen(screen: Screen, event: AppEvent): Screen {
  switch (event.type) {
    case "captured":
      return { phase: "analyzing", capture: event.capture };
    case "analysis-ok": {
      if (
        screen.phase !== "analyzing" ||
        screen.capture.frame.id !== event.analysis.frameId
      ) {
        return screen; // stale result: a cancel/re-capture won
      }
      const { triples } = findSetsInAnalysis(event.analysis);
      return {
        phase: "results",
        capture: screen.capture,
        analysis: event.analysis,
        triples,
        selected: triples.length > 0 ? 0 : -1,
      };
    }
    case "analysis-superseded":
      return screen; // a newer frame's result is coming
    case "analysis-failed":
      if (screen.phase !== "analyzing") return screen;
      return { phase: "idle", notice: guidanceFor(event.stage) };
    case "capture-failed":
      return { phase: "idle", notice: event.message };
    case "cancel":
      return screen.phase === "analyzing"
        ? { phase: "idle", notice: null }
        : screen;
    case "retake":
      return screen.phase === "results"
        ? { phase: "idle", notice: null }
        : screen;
    case "reanalyze":
      return screen.phase === "results"
        ? { phase: "analyzing", capture: screen.capture }
        : screen;
    case "select-set":
      return screen.phase === "results"
        ? { ...screen, selected: event.index }
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
    reveal: event.type === "set-reveal" ? event.mode : state.reveal,
  };
}
