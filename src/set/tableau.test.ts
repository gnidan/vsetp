import { describe, expect, test } from "vitest";
import type { Card, TrackId } from "../model";
import { cardFromKey, cardId, trackId } from "../model";
import type { CardKey } from "../model";
import { findSets, hasSet, makeTableau } from "./tableau";

function entriesOf(keys: string[]) {
  return keys.map((key, i) => ({
    id: cardId(i),
    card: cardFromKey(key as CardKey) as Card,
  }));
}

describe("findSets", () => {
  test("finds the one set in a three-card tableau", () => {
    const t = makeTableau(
      entriesOf(["1-red-oval-solid", "2-red-oval-solid", "3-red-oval-solid"]),
    );
    expect(findSets(t)).toEqual([[cardId(0), cardId(1), cardId(2)]]);
    expect(hasSet(t)).toBe(true);
  });

  test("finds no set when none exists", () => {
    const t = makeTableau(
      entriesOf(["1-red-oval-solid", "2-red-oval-solid", "3-green-oval-solid"]),
    );
    expect(findSets(t)).toEqual([]);
    expect(hasSet(t)).toBe(false);
  });

  test("emits each set once despite multiple discovering pairs", () => {
    // 4 cards containing exactly 2 sets that share a card
    const t = makeTableau(
      entriesOf([
        "1-red-oval-solid",
        "2-red-oval-solid",
        "3-red-oval-solid",
        "1-green-diamond-open",
      ]),
    );
    const sets = findSets(t);
    expect(sets).toHaveLength(1);
  });

  test("handles duplicate faces as distinct detections", () => {
    // the same face twice: a set may use either copy, not both-as-one
    const t = makeTableau(
      entriesOf([
        "1-red-oval-solid",
        "1-red-oval-solid",
        "2-red-oval-solid",
        "3-red-oval-solid",
      ]),
    );
    const sets = findSets(t);
    // {0,2,3} and {1,2,3} — two distinct triples
    expect(sets).toEqual([
      [cardId(0), cardId(2), cardId(3)],
      [cardId(1), cardId(2), cardId(3)],
    ]);
  });

  test("never uses one detection twice in a triple", () => {
    // pair (a, a-duplicate) would complete with a itself if ids were
    // not guarded
    const t = makeTableau(
      entriesOf(["1-red-oval-solid", "1-red-oval-solid", "1-red-oval-solid"]),
    );
    // three identical faces DO form a set (all-same on every
    // attribute) using three distinct detections
    expect(findSets(t)).toEqual([[cardId(0), cardId(1), cardId(2)]]);
  });
});

describe("generic tableau", () => {
  test("solves over TrackId entries", () => {
    // any three cards differing in exactly one attribute form a set
    const cards: Card[] = [
      { count: 1, color: "red", shape: "oval", fill: "solid" },
      { count: 2, color: "red", shape: "oval", fill: "solid" },
      { count: 3, color: "red", shape: "oval", fill: "solid" },
    ];
    const t = makeTableau<TrackId>(
      cards.map((card, i) => ({ id: trackId(i + 10), card })),
    );
    const sets = findSets(t);
    expect(sets).toEqual([[trackId(10), trackId(11), trackId(12)]]);
  });
});
