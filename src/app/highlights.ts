import type { Card, CardId, DetectedCard, FrameAnalysis } from "../model";
import type { SetTriple } from "../set";
import { findSets, makeTableau } from "../set";
import type { SetIdentity } from "../set/identity";
import { setIdentityOf } from "../set/identity";

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
  // Two detections misread as the same face key can yield distinct
  // sets with the same raw identity. Disambiguate, don't dedupe: they
  // involve different physical cards and must render and select
  // independently. First occurrence keeps the bare identity; later
  // ones get a deterministic #n suffix in sets order. Live mode's
  // liveSetsOf must apply this same rule.
  const seen = new Map<SetIdentity, number>();
  return {
    sets: triples.map((triple) => {
      const raw = setIdentityOf(triple.map(cardOf) as [Card, Card, Card]);
      const n = (seen.get(raw) ?? 0) + 1;
      seen.set(raw, n);
      return {
        id: n === 1 ? raw : (`${raw}#${n}` as SetIdentity),
        triple,
      };
    }),
  };
}
