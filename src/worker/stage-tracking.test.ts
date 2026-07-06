import { describe, expect, test } from "vitest";
import type { Quad } from "../model";
import type { CardVision } from "../vision/adapter";
import type { PipelineStage } from "./protocol";
import { withStageTracking } from "./stage-tracking";

const quad: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

function fakeVision(overrides: Partial<CardVision> = {}): CardVision {
  return {
    detectCards: () => [quad],
    rectifyCard: () => new ImageData(2, 2),
    segmentSymbols: () => [],
    ...overrides,
  };
}

describe("withStageTracking", () => {
  test("attributes each adapter stage on entry", () => {
    const stage = { current: "detect" as PipelineStage };
    const vision = withStageTracking(
      fakeVision({
        rectifyCard: () => {
          throw new Error("boom");
        },
      }),
      stage,
    );
    vision.detectCards(new ImageData(2, 2));
    expect(stage.current).toBe("detect");
    expect(() => vision.rectifyCard(new ImageData(2, 2), quad)).toThrow();
    expect(stage.current).toBe("rectify");
  });

  test("after segmentation returns, failures belong to classify", () => {
    const stage = { current: "detect" as PipelineStage };
    const vision = withStageTracking(fakeVision(), stage);
    vision.segmentSymbols(new ImageData(2, 2));
    expect(stage.current).toBe("classify");
  });
});
