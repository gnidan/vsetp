import { describe, expect, it } from "vitest";
import { cardFromKey, frameId, markId } from "../model";
import type { Card, CardKey, Mark, Quad } from "../model";
import type { CardVision, DetectOptions } from "../vision/adapter";
import type { LivePending, MarkEntry } from "./live-mailbox";
import { createLiveSession, processLiveFrame } from "./live-session";

const FRAME = { width: 768, height: 576 };

const CARD_A = cardFromKey("1-red-oval-solid" as CardKey);
const CARD_B = cardFromKey("2-green-squiggle-striped" as CardKey);
const CARD_C = cardFromKey("3-purple-diamond-open" as CardKey);
const conf = { count: 1, color: 1, shape: 1, fill: 1 };

const rect = (x: number, y: number, w = 90, h = 58): Quad => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

// Vision stub: only detectCards is scripted; the read step is
// injected separately, so rectify/segment must never be reached.
function visionStub(
  detectCards: (image: ImageData, options?: DetectOptions) => Quad[],
): CardVision {
  return {
    detectCards,
    rectifyCard: () => {
      throw new Error("unused");
    },
    segmentSymbols: () => {
      throw new Error("unused");
    },
  };
}

function readAs(pick: (quad: Quad) => Card | null) {
  return (
    _vision: CardVision,
    _frame: ImageData,
    quad: Quad,
  ): { card: Card; confidence: typeof conf; quad: Quad } | null => {
    const card = pick(quad);
    return card ? { card, confidence: conf, quad } : null;
  };
}

function pendingOf(id: number, captureMs = 4): LivePending {
  return {
    frame: {
      id: frameId(id),
      width: FRAME.width,
      height: FRAME.height,
      pixels: new ArrayBuffer(FRAME.width * FRAME.height * 4),
    },
    captureMs,
  };
}

function entriesOf(...marks: Mark[]): MarkEntry[] {
  return marks.map((mark, i) => ({ markId: markId(i + 1), mark }));
}

describe("processLiveFrame", () => {
  it("detects, tracks, classifies within budget, and projects", () => {
    const quads = [rect(10, 10), rect(200, 10), rect(400, 10)];
    const vision = visionStub(() => quads);
    // distinct card per quad, keyed by x-position
    const read = readAs((quad) =>
      quad[0].x < 100 ? CARD_A : quad[0].x < 300 ? CARD_B : CARD_C,
    );
    const session = createLiveSession();

    let out = processLiveFrame(vision, session, pendingOf(1), [], 0, read);
    expect(out.tracks).toHaveLength(3);
    out = processLiveFrame(vision, session, pendingOf(2), [], 100, read);
    out = processLiveFrame(vision, session, pendingOf(3), [], 200, read);

    // budget of 2 reads/frame paces consensus: after 3 frames only
    // the first track has 3 consistent votes
    const locked3 = out.tracks.filter((t) => t.state === "locked");
    expect(locked3).toHaveLength(1);
    expect(locked3[0].reading).toEqual(CARD_A);

    out = processLiveFrame(vision, session, pendingOf(4), [], 300, read);
    out = processLiveFrame(vision, session, pendingOf(5), [], 400, read);
    expect(out.tracks.every((t) => t.state === "locked")).toBe(true);
    const byX = [...out.tracks].sort((a, b) => a.quad[0].x - b.quad[0].x);
    expect(byX.map((t) => t.reading)).toEqual([CARD_A, CARD_B, CARD_C]);
  });

  it("marks drain into the tracker (not-a-card suppresses)", () => {
    const vision = visionStub(() => [rect(10, 10)]);
    const read = readAs(() => CARD_A);
    const session = createLiveSession();

    let out = processLiveFrame(vision, session, pendingOf(1), [], 0, read);
    expect(out.tracks).toHaveLength(1);

    const marks = entriesOf({ type: "not-a-card", at: { x: 55, y: 39 } });
    out = processLiveFrame(vision, session, pendingOf(2), marks, 100, read);
    expect(out.tracks).toHaveLength(0);

    // the suppression persists: re-detections at the spot stay out
    out = processLiveFrame(vision, session, pendingOf(3), [], 200, read);
    expect(out.tracks).toHaveLength(0);
  });

  it("roi request adopts a found quad with roi-assist provenance", () => {
    // main detect (full frame) finds nothing; the ROI call gets a
    // square crop (smaller than the frame) and finds one quad
    const vision = visionStub((image) =>
      image.width === image.height && image.width < FRAME.width
        ? [rect(50, 50)]
        : [],
    );
    const read = readAs(() => null);
    const session = createLiveSession();

    const marks = entriesOf({ type: "missed-card", at: { x: 300, y: 300 } });
    const out = processLiveFrame(vision, session, pendingOf(1), marks, 0, read);

    expect(out.tracks).toHaveLength(1);
    expect(out.tracks[0].state).toBe("tentative");
    expect(out.tracks[0].provenance).toBe("roi-assist");
  });

  it("stamps capture and detect timings", () => {
    const vision = visionStub(() => []);
    const read = readAs(() => null);
    const session = createLiveSession();

    const out = processLiveFrame(vision, session, pendingOf(1, 7), [], 0, read);
    expect(out.timings.capture).toBe(7);
    expect(out.timings.detect).toBeGreaterThanOrEqual(0);
    expect(out.timings.classify).toBeGreaterThanOrEqual(0);
    expect(out.timings.roi).toBeGreaterThanOrEqual(0);
  });
});
