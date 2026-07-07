import type { AnalyzedSet } from "../app/highlights";
import type { FrameAnalysis } from "../model";
import type { SetIdentity } from "../set/identity";
import { reading } from "./readings";

// The accessible results list. Visually hidden, semantically primary:
// the visual overlay is aria-hidden and never the sole representation
// (spec + Plan B final review invariant). Spoiler parity: membership
// annotations appear only when the reveal mode discloses sets.
export function SrResults({
  analysis,
  sets,
  selected,
  revealSets,
}: {
  analysis: FrameAnalysis;
  sets: AnalyzedSet[];
  selected: SetIdentity | null;
  revealSets: boolean;
}) {
  const selectedSet = sets.find((set) => set.id === selected);
  return (
    <ol className="sr-only" aria-label="Detected cards">
      {analysis.cards.map((card) => (
        <li key={card.id}>
          {reading(card)}
          {revealSets && selectedSet?.triple.includes(card.id)
            ? " — in the highlighted set"
            : ""}
        </li>
      ))}
    </ol>
  );
}
