import type { AnalyzedSet } from "../app/highlights";
import type { RevealMode } from "../app/state";
import type { FrameAnalysis } from "../model";
import type { SetIdentity } from "../set/identity";
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
  sets,
  selected,
  reveal,
  onSelect,
  onReveal,
  onRetake,
  onReanalyze,
}: {
  analysis: FrameAnalysis;
  sets: AnalyzedSet[];
  selected: SetIdentity | null;
  reveal: RevealMode;
  onSelect(id: SetIdentity): void;
  onReveal(mode: RevealMode): void;
  onRetake(): void;
  onReanalyze(): void;
}) {
  const summary = summaryFor(reveal, analysis.cards.length, sets.length);
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
      {reveal === "sets" && sets.length > 1 && (
        <div className="hud-chips" role="group" aria-label="Found sets">
          {sets.map((set, index) => (
            <button
              key={set.id}
              aria-pressed={set.id === selected}
              onClick={() => onSelect(set.id)}
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
