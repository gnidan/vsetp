import { describe, expect, test } from "vitest";
import type { FrameAnalysis } from "../model";
import { cardId, frameId } from "../model";
import { edgeNotice, guidanceFor } from "./guidance";

describe("guidanceFor", () => {
  test("detect failures get framing guidance", () => {
    expect(guidanceFor("detect")).toMatch(/in frame|glare/i);
  });
  test("classify failures get closer/steadier guidance", () => {
    expect(guidanceFor("classify")).toMatch(/closer|steady/i);
  });
});

describe("edgeNotice", () => {
  const card = (x: number) => ({
    id: cardId(0),
    quad: [
      { x, y: 50 },
      { x: x + 40, y: 50 },
      { x: x + 40, y: 110 },
      { x, y: 110 },
    ] as FrameAnalysis["cards"][number]["quad"],
    card: {
      count: 1,
      color: "red",
      shape: "oval",
      fill: "open",
    } as const,
    confidence: { count: 1, color: 1, shape: 1, fill: 1 },
  });
  const analysisAt = (x: number): FrameAnalysis => ({
    frameId: frameId(1),
    frameSize: { width: 400, height: 300 },
    cards: [card(x)],
    timings: {},
  });

  test("flags a card touching the frame edge", () => {
    expect(edgeNotice(analysisAt(5))).toMatch(/cut off/i);
  });
  test("silent when all cards are interior", () => {
    expect(edgeNotice(analysisAt(100))).toBeNull();
  });
});
