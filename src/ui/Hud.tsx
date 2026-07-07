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

function RevealControl({
  reveal,
  onReveal,
}: {
  reveal: RevealMode;
  onReveal(mode: RevealMode): void;
}) {
  return (
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
  );
}

// Selection chips, one per found set, keyed and selected by IDENTITY
// (never index); rendered only when there is a choice to make.
function SetChips({
  ids,
  selected,
  onSelect,
}: {
  ids: SetIdentity[];
  selected: SetIdentity | null;
  onSelect(id: SetIdentity): void;
}) {
  if (ids.length <= 1) return null;
  return (
    <div className="hud-chips" role="group" aria-label="Found sets">
      {ids.map((id, index) => (
        <button
          key={id}
          aria-pressed={id === selected}
          onClick={() => onSelect(id)}
        >
          {index + 1}
        </button>
      ))}
    </div>
  );
}

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
      <RevealControl reveal={reveal} onReveal={onReveal} />
      {reveal === "sets" && (
        <SetChips
          ids={sets.map((set) => set.id)}
          selected={selected}
          onSelect={onSelect}
        />
      )}
      <div className="hud-actions">
        <button onClick={onRetake}>Retake</button>
        <button onClick={onReanalyze}>Re-analyze</button>
      </div>
    </div>
  );
}

// Live summary per reveal rung. Spoiler parity is enforced by the
// caller: hasSet is the DEBOUNCED presence boolean and is only
// meaningful in presence mode; setIds arrive empty below "sets".
function liveSummaryFor(
  reveal: RevealMode,
  locked: number,
  hasSet: boolean,
  sets: number,
): string {
  switch (reveal) {
    case "cards":
      return `${plural(locked, "card")} read`;
    case "presence":
      return hasSet ? "A set is present" : "No set here";
    case "sets":
      return plural(sets, "set");
  }
}

export function LiveHud({
  lockedCount,
  hasSet,
  setIds,
  selected,
  reveal,
  onSelect,
  onReveal,
  onToggleMode,
}: {
  lockedCount: number;
  hasSet: boolean;
  setIds: SetIdentity[];
  selected: SetIdentity | null;
  reveal: RevealMode;
  onSelect(id: SetIdentity): void;
  onReveal(mode: RevealMode): void;
  onToggleMode(): void;
}) {
  return (
    <div className="hud">
      <p className="hud-summary">
        {liveSummaryFor(reveal, lockedCount, hasSet, setIds.length)}
      </p>
      <RevealControl reveal={reveal} onReveal={onReveal} />
      {reveal === "sets" && (
        <SetChips ids={setIds} selected={selected} onSelect={onSelect} />
      )}
      <div className="hud-actions">
        <button className="mode-toggle" onClick={onToggleMode}>
          Still
        </button>
      </div>
    </div>
  );
}
