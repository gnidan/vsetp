import type { Card, CardId, CardKey } from "../model";
import { cardKey } from "../model";
import { thirdCard } from "./third-card";

export type SetTriple<Id extends number = CardId> = [Id, Id, Id];

export interface TableauEntry<Id extends number = CardId> {
  id: Id;
  card: Card;
}

// immutable snapshot of identified cards on the table
export interface Tableau<Id extends number = CardId> {
  entries: TableauEntry<Id>[];
  byKey: Map<CardKey, Id[]>; // membership multimap
}

export function makeTableau<Id extends number = CardId>(
  entries: TableauEntry<Id>[],
): Tableau<Id> {
  const byKey = new Map<CardKey, Id[]>();
  for (const { id, card } of entries) {
    const key = cardKey(card);
    const ids = byKey.get(key);
    if (ids) ids.push(id);
    else byKey.set(key, [id]);
  }
  return { entries, byKey };
}

function* triples<Id extends number>(t: Tableau<Id>): Generator<SetTriple<Id>> {
  const seen = new Set<string>();
  const { entries, byKey } = t;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const key = cardKey(thirdCard(entries[i].card, entries[j].card));
      for (const id of byKey.get(key) ?? []) {
        if (id === entries[i].id || id === entries[j].id) continue;
        const triple = [entries[i].id, entries[j].id, id].sort(
          (a, b) => a - b,
        ) as SetTriple<Id>;
        const dedup = triple.join(",");
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        yield triple;
      }
    }
  }
}

export function findSets<Id extends number = CardId>(
  t: Tableau<Id>,
): SetTriple<Id>[] {
  return [...triples(t)];
}

export function hasSet<Id extends number = CardId>(t: Tableau<Id>): boolean {
  for (const _ of triples(t)) return true;
  return false;
}
