import { describe, expect, it } from "vitest";
import type { Card } from "../model";
import { setIdentityOf } from "./identity";

const c = (key: string): Card => {
  const [count, color, shape, fill] = key.split("-");
  return {
    count: Number(count) as Card["count"],
    color: color as Card["color"],
    shape: shape as Card["shape"],
    fill: fill as Card["fill"],
  };
};

describe("setIdentityOf", () => {
  it("is order-independent (sorted member keys)", () => {
    const a = c("1-red-oval-solid");
    const b = c("2-green-diamond-open");
    const d = c("3-purple-squiggle-striped");
    expect(setIdentityOf([a, b, d])).toBe(setIdentityOf([d, a, b]));
  });

  it("joins sorted keys with |", () => {
    const a = c("1-red-oval-solid");
    const b = c("2-green-diamond-open");
    const d = c("3-purple-squiggle-striped");
    expect(setIdentityOf([b, d, a])).toBe(
      "1-red-oval-solid|2-green-diamond-open|3-purple-squiggle-striped",
    );
  });
});
