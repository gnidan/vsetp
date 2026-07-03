import { describe, expect, test } from "vitest";
import { allCards, cardKey } from "../model";
import { isSet, thirdCard } from "./third-card";

describe("thirdCard", () => {
  test("all-same attributes stay the same", () => {
    const x = { count: 1, color: "red", shape: "oval", fill: "open" } as const;
    const y = { count: 1, color: "red", shape: "oval", fill: "solid" } as const;
    expect(thirdCard(x, y)).toEqual({
      count: 1,
      color: "red",
      shape: "oval",
      fill: "striped",
    });
  });

  test("is commutative and self-inverse over all pairs", () => {
    const cards = allCards();
    for (const x of cards) {
      for (const y of cards) {
        if (cardKey(x) === cardKey(y)) continue;
        const z = thirdCard(x, y);
        expect(cardKey(thirdCard(y, x))).toBe(cardKey(z));
        expect(cardKey(thirdCard(x, z))).toBe(cardKey(y));
        for (const attr of ["count", "color", "shape", "fill"] as const) {
          const values = new Set([x[attr], y[attr], z[attr]]);
          expect(values.size).not.toBe(2);
        }
      }
    }
  });

  test("thirdCard(x, x) is x for every card", () => {
    for (const x of allCards()) {
      expect(cardKey(thirdCard(x, x))).toBe(cardKey(x));
    }
  });

  test("isSet rejects a non-set", () => {
    const x = { count: 1, color: "red", shape: "oval", fill: "open" } as const;
    const y = { count: 2, color: "red", shape: "oval", fill: "open" } as const;
    const w = {
      count: 2,
      color: "green",
      shape: "oval",
      fill: "open",
    } as const;
    expect(isSet(x, y, w)).toBe(false);
  });
});
