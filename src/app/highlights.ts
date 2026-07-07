import type { Card, CardId, DetectedCard, FrameAnalysis } from "../model";
import type { SetTriple } from "../set";
import { findSets, makeTableau } from "../set";
import type { SetIdentity } from "../set/identity";
import { disambiguateSetIdentities, setIdentityOf } from "../set/identity";

// A found set joined back to this frame's detections: the triple of
// CardIds plus the frame-independent identity of its member faces
// (spec: selection and styling key on identity, never array index).
export interface AnalyzedSet {
  id: SetIdentity;
  triple: SetTriple;
}

// The one construction site of the id-join invariant between solver
// output and detection geometry (spec: Highlight join).
export function findSetsInAnalysis(analysis: FrameAnalysis): {
  sets: AnalyzedSet[];
} {
  const byId = new Map<CardId, DetectedCard>(
    analysis.cards.map((card) => [card.id, card]),
  );
  const cardOf = (id: CardId): Card => {
    const found = byId.get(id);
    if (!found) throw new Error(`unknown CardId ${id}`);
    return found.card;
  };
  const triples = findSets(
    makeTableau(analysis.cards.map(({ id, card }) => ({ id, card }))),
  );
  // Colliding raw identities get #n suffixes in sets order (shared
  // rule with live mode's liveSetsOf; see disambiguateSetIdentities).
  const ids = disambiguateSetIdentities(
    triples.map((triple) =>
      setIdentityOf(triple.map(cardOf) as [Card, Card, Card]),
    ),
  );
  return {
    sets: triples.map((triple, i) => ({ id: ids[i], triple })),
  };
}
