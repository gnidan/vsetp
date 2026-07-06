import type { Frame, FrameId } from "../model";
import { frameId } from "../model";
import { NORMALIZED_MAX_DIMENSION } from "../vision/adapter";

export class CaptureDecodeError extends Error {}

export interface Capture {
  frame: Frame;
  displayUrl: string;
  width: number;
  height: number;
  revoke(): void;
}

export function clampedSize(
  width: number,
  height: number,
  max: number = NORMALIZED_MAX_DIMENSION,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

let counter = 0;
export function mintFrameId(): FrameId {
  return frameId(++counter);
}

type Drawable = HTMLVideoElement | HTMLImageElement | ImageBitmap;

// The single normalization point (spec: Capture normalization): one
// canvas bakes EXIF orientation and the resolution clamp, then yields
// BOTH artifacts — display URL and analysis pixels — so the analyzed
// frame and the displayed image share one coordinate space by
// construction.
async function normalize(
  source: Drawable,
  sourceWidth: number,
  sourceHeight: number,
): Promise<Capture> {
  const { width, height } = clampedSize(sourceWidth, sourceHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new CaptureDecodeError("canvas 2d unavailable");
  context.drawImage(source, 0, 0, width, height);

  const image = context.getImageData(0, 0, width, height);
  const frame: Frame = {
    id: mintFrameId(),
    width,
    height,
    pixels: image.data.buffer,
  };
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.9),
  );
  if (!blob) throw new CaptureDecodeError("could not encode display image");
  const displayUrl = URL.createObjectURL(blob);
  return {
    frame,
    displayUrl,
    width,
    height,
    revoke: () => URL.revokeObjectURL(displayUrl),
  };
}

export async function captureFromVideo(
  video: HTMLVideoElement,
): Promise<Capture> {
  return normalize(video, video.videoWidth, video.videoHeight);
}

async function decodeFile(file: File): Promise<Drawable> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
    } catch {
      // fall through to <img> decode
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } catch {
    throw new CaptureDecodeError(`could not decode ${file.name}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function captureFromFile(file: File): Promise<Capture> {
  const source = await decodeFile(file);
  const width = "videoWidth" in source ? source.videoWidth : source.width;
  const height = "videoHeight" in source ? source.videoHeight : source.height;
  try {
    return await normalize(source, width, height);
  } finally {
    if ("close" in source) source.close();
  }
}
