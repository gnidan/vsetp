import type { DetectedCard } from "../../model";
import { cardId } from "../../model";
import type { CardVision, DetectOptions } from "../adapter";
import { classifyCard } from "./classify";
import { whiteBalanced } from "./classify/pixels";
import { orientQuad } from "./orientation";

export interface AnalyzeOutput {
  cards: DetectedCard[];
  timings: Record<string, number>;
}

// The full still-frame pipeline. CardIds are minted here, sequential
// and frame-local (spec). The worker handler wraps this into a
// FrameAnalysis by stamping frameId and frameSize.
export function analyze(
  vision: CardVision,
  frame: ImageData,
  options?: DetectOptions,
): AnalyzeOutput {
  const timings: Record<string, number> = {
    detect: 0,
    rectify: 0,
    segment: 0,
    classify: 0,
  };
  const t0 = performance.now();
  const quads = vision.detectCards(frame, options);
  timings.detect = performance.now() - t0;

  // a loop (not .map) because output length can differ from
  // quads.length: zero-region quads are skipped below
  const cards: DetectedCard[] = [];
  for (const quad of quads) {
    const t1 = performance.now();
    // white-balance the rectified card against its own border before
    // segmentation: under warm light the unbalanced card face is
    // saturated enough to read as ink (see whiteBalanced)
    const raster = whiteBalanced(vision.rectifyCard(frame, quad));
    const t2 = performance.now();
    const regions = vision.segmentSymbols(raster);
    const t3 = performance.now();
    timings.rectify += t2 - t1;
    timings.segment += t3 - t2;
    if (regions.length === 0) {
      // Zero symbol regions means a card-shaped object with no card
      // face (face-down card, blank card, box lid) — reporting it
      // would feed an all-zero-confidence phantom card to the set
      // solver. Skip the quad entirely: no DetectedCard, no CardId
      // consumed (ids stay sequential over kept cards only).
      continue;
    }
    const { card, confidence } = classifyCard(raster, regions);
    const t4 = performance.now();
    timings.classify += t4 - t3;
    // content-verify the geometric corner ordering before reporting:
    // a foreshortened card can rectify sideways (see orientation.ts).
    // Classification already ran fine on the sideways raster, so only
    // the OUTPUT quad is corrected — no re-rectification.
    cards.push({
      id: cardId(cards.length),
      quad: orientQuad(quad, regions, raster),
      card,
      confidence,
    });
  }
  return { cards, timings };
}
