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
  test("finds triples and joins them back to quads", () => {
    const analysis = analysisOf([
      detected(0, "1-red-oval-solid"),
      detected(1, "2-red-oval-solid"),
      detected(2, "3-red-oval-solid"),
      detected(3, "1-green-diamond-open"),
    ]);
    const { triples, quadsFor } = findSetsInAnalysis(analysis);
    expect(triples).toEqual([[cardId(0), cardId(1), cardId(2)]]);
    const quads = quadsFor(triples[0]);
    expect(quads).toHaveLength(3);
    expect(quads[1][0].x).toBe(10); // id 1's quad, by identity
  });

  test("no sets yields empty triples", () => {
    const analysis = analysisOf([detected(0, "1-red-oval-solid")]);
    expect(findSetsInAnalysis(analysis).triples).toEqual([]);
  });
});
