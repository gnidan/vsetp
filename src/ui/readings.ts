import type { Card } from "../model";

// One card's reading as words. Takes the bare Card so the still path
// (DetectedCard.card) and the live path (Track.reading) share it.
export function reading(card: Card): string {
  const { count, color, shape, fill } = card;
  const plural = count > 1 ? "s" : "";
  return `${count} ${fill} ${color} ${shape}${plural}`;
}
