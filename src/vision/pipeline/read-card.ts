import type { AttributeConfidence, Card, Quad } from "../../model";
import type { CardVision } from "../adapter";
import { classifyCard } from "./classify";
import { whiteBalanced } from "./classify/pixels";
import { orientQuad } from "./orientation";

// Single-quad read: rectify -> white-balance -> segment -> classify,
// with content-verified output orientation. Same four building
// blocks analyze() runs inline over its quad list (see analyze.ts);
// this is the per-quad composition for callers that track cards
// individually rather than re-detecting a whole frame (Tasks 8-9).
// Returns null when the quad has zero symbol regions (face-down
// card, blank, box lid) — the caller must not fabricate a reading
// from it.
export function readCard(
  vision: CardVision,
  frame: ImageData,
  quad: Quad,
): { card: Card; confidence: AttributeConfidence; quad: Quad } | null {
  const raster = whiteBalanced(vision.rectifyCard(frame, quad));
  const regions = vision.segmentSymbols(raster);
  if (regions.length === 0) return null;
  const { card, confidence } = classifyCard(raster, regions);
  return { card, confidence, quad: orientQuad(quad, regions, raster) };
}
