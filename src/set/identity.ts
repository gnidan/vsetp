import type { Card } from "../model";
import { cardKey } from "../model";

// Stable identity of a SET: the sorted member face keys joined.
// Used for line-color assignment and selection (spec: never key
// either to array position).
export type SetIdentity = string & { readonly __brand: "SetIdentity" };

export function setIdentityOf(cards: [Card, Card, Card]): SetIdentity {
  return cards.map(cardKey).sort().join("|") as SetIdentity;
}
