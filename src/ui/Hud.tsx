import type { FrameAnalysis } from "../model";
import type { SetTriple } from "../set";

export function Hud({
  analysis,
  triples,
  selected,
  onSelect,
  onRetake,
  onReanalyze,
}: {
  analysis: FrameAnalysis;
  triples: SetTriple[];
  selected: number;
  onSelect(index: number): void;
  onRetake(): void;
  onReanalyze(): void;
}) {
  const cards = analysis.cards.length;
  const summary =
    cards === 0
      ? "No cards found"
      : triples.length === 0
        ? "No set here"
        : `${triples.length} set${triples.length > 1 ? "s" : ""} found`;
  return (
    <div className="hud">
      <p className="hud-summary">{summary}</p>
      {triples.length > 1 && (
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
