import type { AppState, RevealMode } from "../app/state";
import { edgeNotice } from "../app/guidance";

// How long the live view may sit at zero tracks before the region
// speaks "No cards in view." in every reveal mode (aim-by-audio).
export const NO_CARDS_GRACE_MS = 4000;

// Cadence of Session's live-nudge timer: how often the empty-view
// guidance re-announces while the table stays out of frame.
export const LIVE_NUDGE_MS = 10_000;

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// Spoiler parity: below "sets" reveal, announcements must not leak
// set information beyond what the mode discloses. Shared between
// the results and live screens so their strings can never drift;
// `hasSet` is the presence-mode signal (results: sets > 0; live:
// the DEBOUNCED presence.shown, never raw liveSets).
function revealSummary(
  reveal: RevealMode,
  cards: number,
  hasSet: boolean,
  sets: number,
): string {
  return reveal === "cards"
    ? `${plural(cards, "card")} read.`
    : reveal === "presence"
      ? `${plural(cards, "card")} read. ` +
        (hasSet ? "A set is present." : "No set here.")
      : sets === 0
        ? `No set found among the ${plural(cards, "card")}.`
        : `${plural(sets, "set")} found. ${plural(cards, "card")} read.`;
}

// The full view the announcer speaks from: the reducer's AppState
// plus the App-held reveal rung (hoisted out of the reducer so an
// engine Retry preserves it; see state.ts).
export interface AnnounceState extends AppState {
  reveal: RevealMode;
}

function engineText(engine: AppState["engine"]): string | null {
  if (engine.status === "loading") {
    const { loaded, total } = engine;
    const amount = total
      ? `${Math.round((loaded / total) * 100)}%`
      : `${Math.round(loaded / 1024 / 1024)}MB`;
    return `Loading card reader… ${amount}`;
  }
  if (engine.status === "failed") {
    // speak the specific failure (the overlay's text), so a live
    // stall says "stalled", not a generic "stopped working"
    return `${engine.message} Use Retry to restart.`;
  }
  return null;
}

// One string per app state for the persistent aria-live region.
// Pure so it is trivially testable; App mutates the region's text,
// never the region itself.
export function announcementFor(state: AnnounceState): string {
  const engine = engineText(state.engine);
  if (engine) return engine;
  const { screen } = state;
  switch (screen.phase) {
    case "idle": {
      // the confirmation is the spoken-only "Still mode." transient
      // a mode toggle leaves behind (state.ts live-left); it rides
      // along with any visible notice
      const parts = [screen.notice, screen.confirmation];
      return parts.filter((part) => part !== null).join(" ");
    }
    case "analyzing":
      return "Analyzing…";
    case "results": {
      const sets = screen.sets.length;
      const cards = screen.analysis.cards.length;
      const summary =
        cards === 0
          ? "No cards detected. Try filling the frame with the spread."
          : revealSummary(state.reveal, cards, sets > 0, sets);
      const edge = edgeNotice(screen.analysis);
      return edge ? `${summary} ${edge}` : summary;
    }
    case "live": {
      const base = liveText(screen, state.reveal);
      // feedback confirmations are transient (cleared by the next
      // live update) and ride along with whatever the view says
      const confirmation = screen.lastConfirmation;
      if (!confirmation) return base;
      return base ? `${base} ${confirmation}` : confirmation;
    }
  }
}

function liveText(
  screen: Extract<AppState["screen"], { phase: "live" }>,
  reveal: RevealMode,
): string {
  const { tracks, liveSets, presence, lockedCount } = screen;
  const { emptySince, updatedAt } = screen;
  // aim-by-audio: prolonged empty view speaks in EVERY reveal
  // mode; the clock is the update stream's own timestamps, so
  // the string flips exactly once when the grace period lapses
  if (
    tracks.length === 0 &&
    emptySince !== null &&
    updatedAt !== null &&
    updatedAt - emptySince >= NO_CARDS_GRACE_MS
  ) {
    // aria-live regions only re-speak when the TEXT changes, so
    // a persistently-empty view would announce exactly once.
    // Session bumps announceTick every LIVE_NUDGE_MS while empty;
    // alternating an invisible trailing non-breaking space makes
    // the string differ tick to tick, re-announcing the guidance
    // without altering what a screen reader actually says.
    return screen.announceTick % 2 === 1
      ? "No cards in view.\u00a0"
      : "No cards in view.";
  }
  // quiet until the first card locks ("{n} cards read." fires
  // when lockedCount first reaches n > 0)
  if (lockedCount === 0) return "";
  return revealSummary(reveal, lockedCount, presence.shown, liveSets.length);
}
