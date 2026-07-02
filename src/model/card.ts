export type Count = 1 | 2 | 3;
export type Color = "red" | "green" | "purple";
export type Shape = "diamond" | "oval" | "squiggle";
export type Fill = "solid" | "striped" | "open";

export interface Card {
  count: Count;
  color: Color;
  shape: Shape;
  fill: Fill;
}

// identity of a card FACE — canonical, human-readable
export type CardKey = string & { readonly __brand: "CardKey" };

// runtime attribute values are internal only (spec: no public
// enum constants); the public enumeration surface is allCards()
const COUNTS: readonly Count[] = [1, 2, 3];
const COLORS: readonly Color[] = ["red", "green", "purple"];
const SHAPES: readonly Shape[] = ["diamond", "oval", "squiggle"];
const FILLS: readonly Fill[] = ["solid", "striped", "open"];

export function cardKey(card: Card): CardKey {
  const { count, color, shape, fill } = card;
  return `${count}-${color}-${shape}-${fill}` as CardKey;
}

export function cardFromKey(key: CardKey): Card {
  const parts = key.split("-");
  if (parts.length !== 4) throw new Error(`invalid CardKey: ${key}`);
  const [countRaw, color, shape, fill] = parts;
  const count = Number(countRaw) as Count;
  if (
    !COUNTS.includes(count) ||
    !COLORS.includes(color as Color) ||
    !SHAPES.includes(shape as Shape) ||
    !FILLS.includes(fill as Fill)
  ) {
    throw new Error(`invalid CardKey: ${key}`);
  }
  return {
    count,
    color: color as Color,
    shape: shape as Shape,
    fill: fill as Fill,
  };
}

export function allCards(): Card[] {
  const cards: Card[] = [];
  for (const count of COUNTS)
    for (const color of COLORS)
      for (const shape of SHAPES)
        for (const fill of FILLS) cards.push({ count, color, shape, fill });
  return cards;
}
