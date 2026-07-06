import type { RevealMode } from "../app/state";
import type { FrameAnalysis } from "../model";
import type { SetTriple } from "../set";
import { plural } from "./announce";

// Ladder order — the segmented control renders these left to right.
const REVEAL_STEPS: { mode: RevealMode; label: string }[] = [
  { mode: "cards", label: "Cards" },
  { mode: "presence", label: "Set?" },
  { mode: "sets", label: "Sets" },
];

function summaryFor(reveal: RevealMode, cards: number, sets: number): string {
  if (cards === 0) return "No cards found";
  switch (reveal) {
    case "cards":
      return `${plural(cards, "card")} read`;
    case "presence":
      return sets > 0 ? "A set is present" : "No set here";
    case "sets":
      return sets === 0 ? "No set here" : `${plural(sets, "set")} found`;
  }
}

export function Hud({
  analysis,
  triples,
  selected,
  reveal,
  onSelect,
  onReveal,
  onRetake,
  onReanalyze,
}: {
  analysis: FrameAnalysis;
  triples: SetTriple[];
  selected: number;
  reveal: RevealMode;
  onSelect(index: number): void;
  onReveal(mode: RevealMode): void;
  onRetake(): void;
  onReanalyze(): void;
}) {
  const summary = summaryFor(reveal, analysis.cards.length, triples.length);
  return (
    <div className="hud">
      <p className="hud-summary">{summary}</p>
      <div className="hud-reveal" role="group" aria-label="Reveal level">
        {REVEAL_STEPS.map(({ mode, label }) => (
          <button
            key={mode}
            aria-pressed={reveal === mode}
            onClick={() => onReveal(mode)}
          >
            {label}
          </button>
        ))}
      </div>
      {reveal === "sets" && triples.length > 1 && (
        <div className="hud-chips" role="group" aria-label="Found sets">
          {triples.map((_, index) => (
            <button
              key={index}
              aria-pressed={index === selected}
              onClick={() => onSelect(index)}
            >
              {index + 1}
            </button>
          ))}
        </div>
      )}
      <div className="hud-actions">
        <button onClick={onRetake}>Retake</button>
        <button onClick={onReanalyze}>Re-analyze</button>
      </div>
    </div>
  );
}
