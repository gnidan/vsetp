import type { FrameAnalysis } from "../model";
import type { PipelineStage } from "../worker/protocol";

const EDGE_MARGIN = 12;

// Tabletop-real guidance (spec: condition-based, never "more light")
export function guidanceFor(stage: PipelineStage): string {
  if (stage === "detect") {
    return (
      "Couldn't find cards — make sure the whole spread is in " +
      "frame and tilt the phone to avoid glare."
    );
  }
  return (
    "Couldn't read the cards — move closer, hold steady, and " +
    "avoid casting a shadow."
  );
}

export function edgeNotice(analysis: FrameAnalysis): string | null {
  const { width, height } = analysis.frameSize;
  const cutOff = analysis.cards.some((card) =>
    card.quad.some(
      (p) =>
        p.x < EDGE_MARGIN ||
        p.y < EDGE_MARGIN ||
        p.x > width - EDGE_MARGIN ||
        p.y > height - EDGE_MARGIN,
    ),
  );
  return cutOff ? "Some cards are cut off at the edge." : null;
}
