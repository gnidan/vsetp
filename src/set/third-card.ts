import type { Card, Color, Count, Fill, Shape } from "../model";
import { cardKey } from "../model";

function third<T>(all: readonly T[], a: T, b: T): T {
  if (a === b) return a;
  const rest = all.find((v) => v !== a && v !== b);
  if (rest === undefined) throw new Error("attribute domain exhausted");
  return rest;
}

const COUNTS: readonly Count[] = [1, 2, 3];
const COLORS: readonly Color[] = ["red", "green", "purple"];
const SHAPES: readonly Shape[] = ["diamond", "oval", "squiggle"];
const FILLS: readonly Fill[] = ["solid", "striped", "open"];

// the unique card completing a set with a and b
export function thirdCard(a: Card, b: Card): Card {
  return {
    count: third(COUNTS, a.count, b.count),
    color: third(COLORS, a.color, b.color),
    shape: third(SHAPES, a.shape, b.shape),
    fill: third(FILLS, a.fill, b.fill),
  };
}

export function isSet(a: Card, b: Card, c: Card): boolean {
  return cardKey(thirdCard(a, b)) === cardKey(c);
}
