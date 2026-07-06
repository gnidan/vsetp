import type { DetectedCard } from "../model";

export function reading(card: DetectedCard): string {
  const { count, color, shape, fill } = card.card;
  const plural = count > 1 ? "s" : "";
  return `${count} ${fill} ${color} ${shape}${plural}`;
}
