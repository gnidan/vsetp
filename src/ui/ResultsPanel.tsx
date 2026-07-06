import type { FrameAnalysis } from "../model";
import type { SetTriple } from "../set";
import { edgeNotice } from "../app/guidance";

function reading(card: FrameAnalysis["cards"][number]): string {
  const { count, color, shape, fill } = card.card;
  const plural = count > 1 ? "s" : "";
  return `${count} ${fill} ${color} ${shape}${plural}`;
}

export function ResultsPanel({
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
  const cards = analysis.cards;
  const summary =
    cards.length === 0
      ? "No cards detected. Try filling the frame with the spread."
      : triples.length === 0
        ? `No set among the ${cards.length} cards detected.`
        : `${triples.length} set${triples.length > 1 ? "s" : ""} found.`;
  const notice = edgeNotice(analysis);
  return (
    <section className="results-panel">
      <p aria-live="polite" className="summary">
        {summary}
      </p>
      {notice && <p className="notice">{notice}</p>}
      {triples.length > 1 && (
        <div className="set-chips" role="group" aria-label="Found sets">
          {triples.map((_, index) => (
            <button
              key={index}
              aria-pressed={index === selected}
              onClick={() => onSelect(index)}
            >
              Set {index + 1}
            </button>
          ))}
        </div>
      )}
      <ol className="card-list" aria-label="Detected cards">
        {cards.map((card) => (
          <li key={card.id}>
            {reading(card)}
            {selected >= 0 && triples[selected]?.includes(card.id)
              ? " — in the highlighted set"
              : ""}
          </li>
        ))}
      </ol>
      <div className="actions">
        <button onClick={onRetake}>Retake</button>
        <button onClick={onReanalyze}>Re-analyze</button>
      </div>
    </section>
  );
}
