import { describe, expect, test } from "vitest";
import { settleOpenCv } from "./runtime";

describe("settleOpenCv", () => {
  test("returns an already-initialized module directly", async () => {
    const cv = { Mat: class {} };
    expect(await settleOpenCv(cv)).toBe(cv);
  });

  test("waits for onRuntimeInitialized", async () => {
    const cv: Record<string, unknown> = {};
    const settled = settleOpenCv(cv);
    expect(typeof cv.onRuntimeInitialized).toBe("function");
    (cv.onRuntimeInitialized as () => void)();
    expect(await settled).toBe(cv);
  });

  test("chains a pre-existing onRuntimeInitialized handler", async () => {
    let chained = false;
    const cv: Record<string, unknown> = {
      onRuntimeInitialized: () => {
        chained = true;
      },
    };
    const settled = settleOpenCv(cv);
    (cv.onRuntimeInitialized as () => void)();
    await settled;
    expect(chained).toBe(true);
  });

  test("neuters a self-resolving thenable without awaiting it", async () => {
    // the real artifact's Module is thenable and re-adopts itself
    // forever if awaited; settleOpenCv must delete `then` and settle
    // via onRuntimeInitialized instead
    let thenCalls = 0;
    const cv: Record<string, unknown> = {
      then: () => {
        thenCalls++;
      },
    };
    const settled = settleOpenCv(cv);
    expect("then" in cv).toBe(false); // neutered
    (cv.onRuntimeInitialized as () => void)();
    expect(await settled).toBe(cv);
    expect(thenCalls).toBe(0); // never awaited/adopted
  });

  test("calls a factory export and settles its product", async () => {
    const product: Record<string, unknown> = {};
    const factory = () => {
      queueMicrotask(() => (product.onRuntimeInitialized as () => void)());
      return product;
    };
    expect(await settleOpenCv(factory)).toBe(product);
  });
});
