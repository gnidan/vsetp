import type { AppState } from "../app/state";
import { edgeNotice } from "../app/guidance";

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
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
    return "The card reader stopped working. Use Retry to restart.";
  }
  return null;
}

// One string per app state for the persistent aria-live region.
// Pure so it is trivially testable; App mutates the region's text,
// never the region itself.
export function announcementFor(state: AppState): string {
  const engine = engineText(state.engine);
  if (engine) return engine;
  const { screen } = state;
  switch (screen.phase) {
    case "idle":
      return screen.notice ?? "";
    case "analyzing":
      return "Analyzing…";
    case "results": {
      const sets = screen.triples.length;
      const cards = screen.analysis.cards.length;
      // Spoiler parity: below "sets" reveal, announcements must not
      // leak set information beyond what the mode discloses.
      const summary =
        cards === 0
          ? "No cards detected. Try filling the frame with the spread."
          : state.reveal === "cards"
            ? `${plural(cards, "card")} read.`
            : state.reveal === "presence"
              ? `${plural(cards, "card")} read. ` +
                (sets > 0 ? "A set is present." : "No set here.")
              : sets === 0
                ? `No set found among the ${plural(cards, "card")}.`
                : `${plural(sets, "set")} found. ` +
                  `${plural(cards, "card")} read.`;
      const edge = edgeNotice(screen.analysis);
      return edge ? `${summary} ${edge}` : summary;
    }
  }
}
