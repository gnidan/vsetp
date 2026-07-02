export type FrameId = number & { readonly __brand: "FrameId" };

export function frameId(n: number): FrameId {
  return n as FrameId;
}

// the unit of pipeline input; produced by capture normalization
export interface Frame {
  id: FrameId;
  width: number;
  height: number;
  pixels: ArrayBuffer; // RGBA, width * height * 4; transferable
}
