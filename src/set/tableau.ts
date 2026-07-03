import type { Card, CardId, CardKey } from "../model";
import { cardKey } from "../model";
import { thirdCard } from "./third-card";

export type SetTriple = [CardId, CardId, CardId];

export interface TableauEntry {
  id: CardId;
  card: Card;
}

// immutable snapshot of identified cards on the table
export interface Tableau {
  entries: TableauEntry[];
  byKey: Map<CardKey, CardId[]>; // membership multimap
}

export function makeTableau(entries: TableauEntry[]): Tableau {
  const byKey = new Map<CardKey, CardId[]>();
  for (const { id, card } of entries) {
    const key = cardKey(card);
    const ids = byKey.get(key);
    if (ids) ids.push(id);
    else byKey.set(key, [id]);
  }
  return { entries, byKey };
}

function* triples(t: Tableau): Generator<SetTriple> {
  const seen = new Set<string>();
  const { entries, byKey } = t;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const key = cardKey(thirdCard(entries[i].card, entries[j].card));
      for (const id of byKey.get(key) ?? []) {
        if (id === entries[i].id || id === entries[j].id) continue;
        const triple = [entries[i].id, entries[j].id, id].sort(
          (a, b) => a - b,
        ) as SetTriple;
        const dedup = triple.join(",");
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        yield triple;
      }
    }
  }
}

export function findSets(t: Tableau): SetTriple[] {
  return [...triples(t)];
}

export function hasSet(t: Tableau): boolean {
  for (const _ of triples(t)) return true;
  return false;
}
