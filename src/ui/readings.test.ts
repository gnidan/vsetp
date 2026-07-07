import { describe, expect, test } from "vitest";
import type { DetectedCard } from "../model";
import { cardId } from "../model";
import { reading } from "./readings";

function card(overrides: Partial<DetectedCard["card"]>): DetectedCard {
  return {
    id: cardId(0),
    quad: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    card: {
      count: 2,
      color: "red",
      shape: "oval",
      fill: "striped",
      ...overrides,
    },
    confidence: { count: 1, color: 1, shape: 1, fill: 1 },
  };
}

describe("reading", () => {
  test("words in count-fill-color-shape order, pluralized", () => {
    expect(reading(card({}).card)).toBe("2 striped red ovals");
  });
  test("singular for count 1", () => {
    expect(reading(card({ count: 1, shape: "diamond" }).card)).toBe(
      "1 striped red diamond",
    );
  });
});
