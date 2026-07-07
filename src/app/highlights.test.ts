import { describe, expect, test } from "vitest";
import type { Card, DetectedCard, FrameAnalysis } from "../model";
import { cardFromKey, cardId, frameId } from "../model";
import type { CardKey } from "../model";
import { findSetsInAnalysis } from "./highlights";

function detected(id: number, key: string): DetectedCard {
  const card: Card = cardFromKey(key as CardKey);
  const base = id * 10;
  return {
    id: cardId(id),
    quad: [
      { x: base, y: 0 },
      { x: base + 5, y: 0 },
      { x: base + 5, y: 8 },
      { x: base, y: 8 },
    ],
    card,
    confidence: { count: 1, color: 1, shape: 1, fill: 1 },
  };
}

function analysisOf(cards: DetectedCard[]): FrameAnalysis {
  return {
    frameId: frameId(1),
    frameSize: { width: 100, height: 100 },
    cards,
    timings: {},
  };
}

describe("findSetsInAnalysis", () => {
  test("finds sets with triples and identities", () => {
    const analysis = analysisOf([
      detected(0, "1-red-oval-solid"),
      detected(1, "2-red-oval-solid"),
      detected(2, "3-red-oval-solid"),
      detected(3, "1-green-diamond-open"),
    ]);
    const { sets } = findSetsInAnalysis(analysis);
    expect(sets).toHaveLength(1);
    expect(sets[0].triple).toEqual([cardId(0), cardId(1), cardId(2)]);
    expect(sets[0].id).toBe(
      "1-red-oval-solid|2-red-oval-solid|3-red-oval-solid",
    );
  });

  test("identity is stable across detection order and ids", () => {
    const forward = findSetsInAnalysis(
      analysisOf([
        detected(0, "1-red-oval-solid"),
        detected(1, "2-red-oval-solid"),
        detected(2, "3-red-oval-solid"),
      ]),
    );
    const shuffled = findSetsInAnalysis(
      analysisOf([
        detected(4, "3-red-oval-solid"),
        detected(7, "1-red-oval-solid"),
        detected(9, "2-red-oval-solid"),
      ]),
    );
    expect(forward.sets[0].id).toBe(shuffled.sets[0].id);
  });

  test("no sets yields empty list", () => {
    const analysis = analysisOf([detected(0, "1-red-oval-solid")]);
    expect(findSetsInAnalysis(analysis).sets).toEqual([]);
  });
});
