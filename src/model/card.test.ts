import { describe, expect, test } from "vitest";
import { allCards, cardFromKey, cardKey } from "./card";

describe("cardKey", () => {
  test("formats as count-color-shape-fill", () => {
    expect(
      cardKey({ count: 2, color: "red", shape: "oval", fill: "striped" }),
    ).toBe("2-red-oval-striped");
  });

  test("all 81 cards have distinct keys that round-trip", () => {
    const cards = allCards();
    expect(cards).toHaveLength(81);
    const keys = cards.map(cardKey);
    expect(new Set(keys).size).toBe(81);
    for (const card of cards) {
      expect(cardFromKey(cardKey(card))).toEqual(card);
    }
  });

  test("cardFromKey rejects malformed keys", () => {
    expect(() => cardFromKey("4-red-oval-striped" as never)).toThrow();
    expect(() => cardFromKey("nonsense" as never)).toThrow();
    expect(() => cardFromKey("2-red-oval-striped-extra" as never)).toThrow();
    expect(() => cardFromKey("2-red-oval" as never)).toThrow();
    expect(() => cardFromKey("01-red-oval-solid" as never)).toThrow();
    expect(() => cardFromKey("1e0-red-oval-solid" as never)).toThrow();
  });
});
