import { beforeAll, expect, test } from "vitest";
import type { Cv } from "./cv";
import { loadOpenCv } from "./load-node";

let cv: Cv;

beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000); // WASM init is slow; known vitest hang risk — keep timeout

test("initializes and round-trips a Mat from ImageData", () => {
  const image = new ImageData(4, 3);
  image.data.fill(255);
  const mat = cv.matFromImageData(image);
  expect(mat.rows).toBe(3);
  expect(mat.cols).toBe(4);
  mat.delete();
});

test("loadOpenCv is a cached singleton", async () => {
  expect(await loadOpenCv()).toBe(cv);
});
