import { describe, expect, test } from "vitest";
import { clampedSize, mintFrameId } from "./capture";

describe("clampedSize", () => {
  test("passes small frames through untouched", () => {
    expect(clampedSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  test("clamps the long edge to NORMALIZED_MAX_DIMENSION", () => {
    expect(clampedSize(4000, 3000)).toEqual({ width: 3072, height: 2304 });
    expect(clampedSize(3000, 4000)).toEqual({ width: 2304, height: 3072 });
  });

  test("rounds to integers", () => {
    const { width, height } = clampedSize(4032, 3024);
    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
    expect(width).toBe(3072);
  });

  test("never collapses an edge to zero on extreme aspect", () => {
    const { width, height } = clampedSize(1, 1_000_000);
    expect(width).toBeGreaterThanOrEqual(1);
    expect(height).toBe(3072);
  });
});

describe("mintFrameId", () => {
  test("is monotonic", () => {
    const a = mintFrameId();
    const b = mintFrameId();
    expect(b).toBeGreaterThan(a);
  });
});
