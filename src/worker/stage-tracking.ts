import type { CardVision } from "../vision/adapter";
import type { PipelineStage } from "./protocol";

// Wrap the adapter so analyze() failures can name their stage: each
// method claims the stage on entry; once segmentation has returned,
// any later throw is pure classification work.
export function withStageTracking(
  vision: CardVision,
  stage: { current: PipelineStage },
): CardVision {
  return {
    detectCards: (frame, options) => {
      stage.current = "detect";
      return vision.detectCards(frame, options);
    },
    rectifyCard: (frame, quad) => {
      stage.current = "rectify";
      return vision.rectifyCard(frame, quad);
    },
    segmentSymbols: (card) => {
      stage.current = "segment";
      const regions = vision.segmentSymbols(card);
      stage.current = "classify";
      return regions;
    },
  };
}
