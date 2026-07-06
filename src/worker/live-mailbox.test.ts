import { describe, expect, it } from "vitest";
import { frameId, markId } from "../model";
import type { Frame } from "../model";
import {
  acceptFrame,
  acceptMark,
  clearLiveMailbox,
  createLiveMailbox,
  drainMarks,
  nextFrame,
} from "./live-mailbox";

const frame = (n: number): Frame => ({
  id: frameId(n),
  width: 4,
  height: 4,
  pixels: new ArrayBuffer(64),
});

describe("live mailbox", () => {
  it("newest frame wins; displaced frame id is returned", () => {
    const box = createLiveMailbox();
    expect(acceptFrame(box, { frame: frame(1), captureMs: 1 })).toBe(null);
    expect(acceptFrame(box, { frame: frame(2), captureMs: 1 })).toBe(
      frameId(1),
    );
    expect(nextFrame(box)?.frame.id).toBe(frameId(2));
    expect(nextFrame(box)).toBe(null);
  });

  it("marks are never dropped by frame displacement", () => {
    const box = createLiveMailbox();
    acceptFrame(box, { frame: frame(1), captureMs: 1 });
    acceptMark(box, {
      markId: markId(1),
      mark: { type: "missed-card", at: { x: 1, y: 1 } },
    });
    acceptFrame(box, { frame: frame(2), captureMs: 1 }); // displaces
    const marks = drainMarks(box);
    expect(marks).toHaveLength(1);
    expect(marks[0].markId).toBe(markId(1));
    expect(drainMarks(box)).toHaveLength(0); // drained
  });

  it("clearLiveMailbox drops the waiting frame and queued marks", () => {
    const box = createLiveMailbox();
    acceptFrame(box, { frame: frame(1), captureMs: 1 });
    acceptMark(box, {
      markId: markId(1),
      mark: { type: "missed-card", at: { x: 1, y: 1 } },
    });
    clearLiveMailbox(box);
    expect(nextFrame(box)).toBe(null);
    expect(drainMarks(box)).toHaveLength(0);
  });
});
