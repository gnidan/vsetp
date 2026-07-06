import type { FrameAnalysis } from "../model";
import type { SetTriple } from "../set";
import { reading } from "./readings";

// The accessible results list. Visually hidden, semantically primary:
// the visual overlay is aria-hidden and never the sole representation
// (spec + Plan B final review invariant). Spoiler parity: membership
// annotations appear only when the reveal mode discloses sets.
export function SrResults({
  analysis,
  triples,
  selected,
  revealSets,
}: {
  analysis: FrameAnalysis;
  triples: SetTriple[];
  selected: number;
  revealSets: boolean;
}) {
  return (
    <ol className="sr-only" aria-label="Detected cards">
      {analysis.cards.map((card) => (
        <li key={card.id}>
          {reading(card)}
          {revealSets && selected >= 0 && triples[selected]?.includes(card.id)
            ? " — in the highlighted set"
            : ""}
        </li>
      ))}
    </ol>
  );
}
