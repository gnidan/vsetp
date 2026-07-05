import { describe, expect, test } from "vitest";
import { isWorkerRequest, isWorkerResponse } from "./protocol";

describe("boundary guards", () => {
  test("accepts every request kind", () => {
    expect(isWorkerRequest({ type: "init", wasmUrl: "/vendor/x.js" })).toBe(
      true,
    );
    expect(
      isWorkerRequest({
        type: "analyze",
        frame: { id: 1, width: 2, height: 2, pixels: new ArrayBuffer(16) },
      }),
    ).toBe(true);
  });

  test("accepts every response kind", () => {
    for (const message of [
      { type: "init-progress", loaded: 10, total: null },
      { type: "ready" },
      { type: "init-error", message: "boom" },
      {
        type: "result",
        frameId: 1,
        analysis: {
          frameId: 1,
          frameSize: { width: 2, height: 2 },
          cards: [],
          timings: {},
        },
      },
      { type: "dropped", frameId: 1 },
      {
        type: "analyze-error",
        frameId: 1,
        stage: "detect",
        message: "boom",
      },
    ]) {
      expect(isWorkerResponse(message)).toBe(true);
    }
  });

  test("rejects junk", () => {
    expect(isWorkerRequest(null)).toBe(false);
    expect(isWorkerRequest({ type: "result" })).toBe(false);
    expect(isWorkerResponse({ type: "analyze" })).toBe(false);
    expect(isWorkerResponse("ready")).toBe(false);
  });
});
