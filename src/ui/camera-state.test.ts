import { describe, expect, test } from "vitest";
import { cameraReduce } from "./camera-state";

describe("cameraReduce", () => {
  test("happy path: unprimed -> starting -> live", () => {
    expect(cameraReduce("unprimed", "enable")).toBe("starting");
    expect(cameraReduce("starting", "granted")).toBe("live");
  });
  test("denied lands unavailable; enable can retry from there", () => {
    expect(cameraReduce("starting", "denied")).toBe("unavailable");
    expect(cameraReduce("unavailable", "enable")).toBe("starting");
  });
  test("live ignores enable; stopped resets", () => {
    expect(cameraReduce("live", "enable")).toBe("live");
    expect(cameraReduce("live", "stopped")).toBe("unprimed");
  });
});
