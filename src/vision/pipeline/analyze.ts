import type { DetectedCard } from "../../model";
import { cardId } from "../../model";
import type { CardVision, DetectOptions } from "../adapter";
import { classifyCard } from "./classify";

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

  const cards: DetectedCard[] = quads.map((quad, index) => {
    const t1 = performance.now();
    const raster = vision.rectifyCard(frame, quad);
    const t2 = performance.now();
    const regions = vision.segmentSymbols(raster);
    const t3 = performance.now();
    const { card, confidence } = classifyCard(raster, regions);
    const t4 = performance.now();
    timings.rectify += t2 - t1;
    timings.segment += t3 - t2;
    timings.classify += t4 - t3;
    return { id: cardId(index), quad, card, confidence };
  });
  return { cards, timings };
}
