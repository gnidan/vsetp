import type { Card } from "./card";
import type { FrameId } from "./frame";
import type { Quad } from "./geometry";

export type CardId = number & { readonly __brand: "CardId" };

export function cardId(n: number): CardId {
  return n as CardId;
}

export interface AttributeConfidence {
  count: number; // 0..1, per-attribute calibrated
  color: number;
  shape: number;
  fill: number;
}

export interface DetectedCard {
  id: CardId;
  quad: Quad;
  card: Card;
  confidence: AttributeConfidence;
}

export interface FrameAnalysis {
  frameId: FrameId;
  frameSize: { width: number; height: number };
  cards: DetectedCard[];
  timings: Record<string, number>; // per-stage ms
}
