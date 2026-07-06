import type { CardId, DetectedCard, FrameAnalysis, Quad } from "../model";
import type { SetTriple } from "../set";
import { findSets, makeTableau } from "../set";

// The one construction site of the id-join invariant between solver
// output and detection geometry (spec: Highlight join).
export function findSetsInAnalysis(analysis: FrameAnalysis): {
  triples: SetTriple[];
  quadsFor(triple: SetTriple): Quad[];
} {
  const byId = new Map<CardId, DetectedCard>(
    analysis.cards.map((card) => [card.id, card]),
  );
  const triples = findSets(
    makeTableau(analysis.cards.map(({ id, card }) => ({ id, card }))),
  );
  return {
    triples,
    quadsFor: (triple) =>
      triple.map((id) => {
        const found = byId.get(id);
        if (!found) throw new Error(`unknown CardId ${id}`);
        return found.quad;
      }),
  };
}
