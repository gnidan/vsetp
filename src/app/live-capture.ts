import type { Frame } from "../model";
import { clampedSize, mintFrameId } from "./capture";

export const LIVE_FRAME_MAX_DIMENSION = 768;

export interface VideoLike {
  videoWidth: number;
  videoHeight: number;
}

export interface ContextLike {
  drawImage(
    source: unknown,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  getImageData(x: number, y: number, w: number, h: number): ImageData;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(id: "2d"): ContextLike | null;
}

export interface LiveFrameCapture {
  frame: Frame;
  captureMs: number;
}

// Persistent-canvas capturer: ONE canvas for the session, resized
// only when video dimensions change; pixels only — no toBlob, no
// object URLs, ever (spec).
export function createLiveCapturer(
  makeCanvas: () => CanvasLike = () =>
    document.createElement("canvas") as unknown as CanvasLike,
): (video: VideoLike) => LiveFrameCapture {
  let canvas: CanvasLike | null = null;
  let context: ContextLike | null = null;

  return (video: VideoLike): LiveFrameCapture => {
    const start = performance.now();
    const { width, height } = clampedSize(
      video.videoWidth,
      video.videoHeight,
      LIVE_FRAME_MAX_DIMENSION,
    );
    if (!canvas) {
      canvas = makeCanvas();
      context = canvas.getContext("2d");
    }
    if (!context) {
      throw new Error("live capture: canvas 2d context unavailable");
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(video, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const frame: Frame = {
      id: mintFrameId(),
      width,
      height,
      pixels: image.data.buffer,
    };
    return { frame, captureMs: performance.now() - start };
  };
}
