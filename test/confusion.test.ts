import { describe, expect, test } from "vitest";
import { confusionMatrix, formatConfusion } from "./confusion";

describe("confusionMatrix", () => {
  test("tallies expected vs actual", () => {
    const m = confusionMatrix([
      { expected: "red", actual: "red" },
      { expected: "red", actual: "purple" },
      { expected: "green", actual: "green" },
    ]);
    expect(m.red.red).toBe(1);
    expect(m.red.purple).toBe(1);
    expect(m.green.green).toBe(1);
    expect(formatConfusion(m)).toContain("red");
  });
});
