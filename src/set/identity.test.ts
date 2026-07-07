import { describe, expect, it } from "vitest";
import type { Card } from "../model";
import type { SetIdentity } from "./identity";
import { disambiguateSetIdentities, setIdentityOf } from "./identity";

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

describe("disambiguateSetIdentities", () => {
  const id = (s: string): SetIdentity => s as SetIdentity;

  it("leaves collision-free identities untouched", () => {
    expect(disambiguateSetIdentities([id("a"), id("b")])).toEqual([
      id("a"),
      id("b"),
    ]);
  });

  it("suffixes later occurrences with #n, first stays bare", () => {
    expect(
      disambiguateSetIdentities([id("a"), id("b"), id("a"), id("a")]),
    ).toEqual([id("a"), id("b"), id("a#2"), id("a#3")]);
  });

  it("preserves input order", () => {
    expect(disambiguateSetIdentities([id("b"), id("a"), id("b")])).toEqual([
      id("b"),
      id("a"),
      id("b#2"),
    ]);
  });

  it("handles the empty list", () => {
    expect(disambiguateSetIdentities([])).toEqual([]);
  });
});
