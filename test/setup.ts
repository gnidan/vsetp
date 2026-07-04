// Node lacks ImageData; the vision code passes it across the adapter
// boundary. Minimal spec-shaped shim, installed only when absent.
if (typeof globalThis.ImageData === "undefined") {
  class NodeImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    readonly colorSpace = "srgb";

    constructor(
      dataOrWidth: Uint8ClampedArray | number,
      w: number,
      h?: number,
    ) {
      if (typeof dataOrWidth === "number") {
        this.width = dataOrWidth;
        this.height = w;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      } else {
        this.data = dataOrWidth;
        this.width = w;
        this.height = h ?? dataOrWidth.length / 4 / w;
        if (dataOrWidth.length !== this.width * this.height * 4) {
          throw new Error("ImageData: data length mismatch");
        }
      }
    }
  }
  (globalThis as Record<string, unknown>).ImageData = NodeImageData;
}
export {};
