import type { Quad } from "../../model";
import { CARD_RASTER } from "../adapter";
import type { Cv } from "./cv";

export function rectifyCard(cv: Cv, frame: ImageData, quad: Quad): ImageData {
  const { width, height } = CARD_RASTER;
  let src: Cv = null;
  let srcCorners: Cv = null;
  let dstCorners: Cv = null;
  let transform: Cv = null;
  let dst: Cv = null;
  try {
    src = cv.matFromImageData(frame);
    srcCorners = cv.matFromArray(4, 1, cv.CV_32FC2, [
      quad[0].x,
      quad[0].y,
      quad[1].x,
      quad[1].y,
      quad[2].x,
      quad[2].y,
      quad[3].x,
      quad[3].y,
    ]);
    dstCorners = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0,
      0,
      width,
      0,
      width,
      height,
      0,
      height,
    ]);
    transform = cv.getPerspectiveTransform(srcCorners, dstCorners);
    dst = new cv.Mat();
    cv.warpPerspective(
      src,
      dst,
      transform,
      new cv.Size(width, height),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE,
      new cv.Scalar(),
    );
    return new ImageData(
      new Uint8ClampedArray(dst.data.slice()),
      width,
      height,
    );
  } finally {
    dst?.delete();
    transform?.delete();
    dstCorners?.delete();
    srcCorners?.delete();
    src?.delete();
  }
}
