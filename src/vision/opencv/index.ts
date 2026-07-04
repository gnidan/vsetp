import type { CardVision } from "../adapter";
import type { Cv } from "./cv";
import { detectCards } from "./detect";
import { rectifyCard } from "./rectify";
import { segmentSymbols } from "./segment";

export function createCardVision(cv: Cv): CardVision {
  return {
    detectCards: (frame, options) => detectCards(cv, frame, options),
    rectifyCard: (frame, quad) => rectifyCard(cv, frame, quad),
    segmentSymbols: (card) => segmentSymbols(cv, card),
  };
}
