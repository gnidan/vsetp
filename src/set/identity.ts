import type { Card } from "../model";
import { cardKey } from "../model";

// Stable identity of a SET: the sorted member face keys joined.
// Used for line-color assignment and selection (spec: never key
// either to array position).
export type SetIdentity = string & { readonly __brand: "SetIdentity" };

export function setIdentityOf(cards: [Card, Card, Card]): SetIdentity {
  return cards.map(cardKey).sort().join("|") as SetIdentity;
}

// Two detections misread as the same face key can yield distinct
// sets with the same raw identity. Disambiguate, don't dedupe: they
// involve different physical cards and must render and select
// independently. First occurrence keeps the bare identity; later
// ones get a deterministic #n suffix in input order.
export function disambiguateSetIdentities(raw: SetIdentity[]): SetIdentity[] {
  const seen = new Map<SetIdentity, number>();
  return raw.map((id) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : (`${id}#${n}` as SetIdentity);
  });
}
