import { describe, expect, test } from "vitest";
import type { CanvasLike, ContextLike, VideoLike } from "./live-capture";
import { LIVE_FRAME_MAX_DIMENSION, createLiveCapturer } from "./live-capture";

class FakeContext implements ContextLike {
  drawImage(
    _source: unknown,
    _dx: number,
    _dy: number,
    _dw: number,
    _dh: number,
  ): void {}

  getImageData(_x: number, _y: number, w: number, h: number): ImageData {
    return new ImageData(w, h);
  }
}

class FakeCanvas implements CanvasLike {
  private widthValue = 0;
  private heightValue = 0;
  resizeCount = 0;
  private readonly context = new FakeContext();

  get width(): number {
    return this.widthValue;
  }
  set width(value: number) {
    if (value !== this.widthValue) this.resizeCount++;
    this.widthValue = value;
  }
  get height(): number {
    return this.heightValue;
  }
  set height(value: number) {
    if (value !== this.heightValue) this.resizeCount++;
    this.heightValue = value;
  }

  getContext(_id: "2d"): ContextLike | null {
    return this.context;
  }
}

function fakeFactory() {
  const canvases: FakeCanvas[] = [];
  const makeCanvas = (): CanvasLike => {
    const canvas = new FakeCanvas();
    canvases.push(canvas);
    return canvas;
  };
  return { makeCanvas, canvases };
}

const video1080p: VideoLike = { videoWidth: 1920, videoHeight: 1080 };
const video4to3: VideoLike = { videoWidth: 1600, videoHeight: 1200 };

describe("createLiveCapturer", () => {
  test("clamps the long edge to LIVE_FRAME_MAX_DIMENSION", () => {
    const { makeCanvas } = fakeFactory();
    const capture = createLiveCapturer(makeCanvas);
    const { frame } = capture(video1080p);
    expect(Math.max(frame.width, frame.height)).toBe(LIVE_FRAME_MAX_DIMENSION);
    expect(frame.pixels.byteLength).toBe(frame.width * frame.height * 4);
  });

  test("constructs one canvas across two captures of the same size", () => {
    const { makeCanvas, canvases } = fakeFactory();
    const capture = createLiveCapturer(makeCanvas);
    capture(video1080p);
    capture(video1080p);
    expect(canvases).toHaveLength(1);
  });

  test("resizes the same canvas on a video dimension change", () => {
    const { makeCanvas, canvases } = fakeFactory();
    const capture = createLiveCapturer(makeCanvas);
    const first = capture(video1080p);
    const resizesBefore = canvases[0].resizeCount;
    const second = capture(video4to3);
    expect(canvases).toHaveLength(1); // no new construction
    expect(canvases[0].resizeCount).toBeGreaterThan(resizesBefore);
    expect(second.frame.height).not.toBe(first.frame.height);
  });

  test("mints a fresh, monotonic frame id per capture", () => {
    const { makeCanvas } = fakeFactory();
    const capture = createLiveCapturer(makeCanvas);
    const first = capture(video1080p);
    const second = capture(video1080p);
    expect(second.frame.id).toBeGreaterThan(first.frame.id);
  });

  test("captureMs is non-negative", () => {
    const { makeCanvas } = fakeFactory();
    const capture = createLiveCapturer(makeCanvas);
    const { captureMs } = capture(video1080p);
    expect(captureMs).toBeGreaterThanOrEqual(0);
  });
});
