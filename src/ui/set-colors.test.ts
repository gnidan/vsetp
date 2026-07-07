import { describe, expect, test } from "vitest";
import type { SetIdentity } from "../set/identity";
import { SET_LINE_COLORS } from "./set-lines";
import { createSetColorMap } from "./set-colors";

const id = (s: string) => s as SetIdentity;

describe("createSetColorMap", () => {
  test("assigns palette colors by first-appearance order", () => {
    const map = createSetColorMap();
    expect(map.colorFor(id("a")).color).toBe(SET_LINE_COLORS[0]);
    expect(map.colorFor(id("b")).color).toBe(SET_LINE_COLORS[1]);
    expect(map.colorFor(id("c")).color).toBe(SET_LINE_COLORS[2]);
    expect(map.colorFor(id("d")).color).toBe(SET_LINE_COLORS[3]);
  });

  test("an identity keeps its assignment for the session", () => {
    const map = createSetColorMap();
    const first = map.colorFor(id("a"));
    map.colorFor(id("b"));
    map.colorFor(id("c"));
    expect(map.colorFor(id("a"))).toEqual(first);
    // even after it disappears and other identities appear
    map.colorFor(id("d"));
    map.colorFor(id("e"));
    expect(map.colorFor(id("a"))).toEqual(first);
  });

  test("colors cycle and dashes start at the fifth identity", () => {
    const map = createSetColorMap();
    for (let i = 0; i < 8; i++) {
      const { color, dash } = map.colorFor(id(`set-${i}`));
      expect(color).toBe(SET_LINE_COLORS[i % SET_LINE_COLORS.length]);
      expect(dash).toBe(i >= 4);
    }
  });

  test("maps are independent sessions", () => {
    const a = createSetColorMap();
    const b = createSetColorMap();
    a.colorFor(id("x"));
    expect(b.colorFor(id("y")).color).toBe(SET_LINE_COLORS[0]);
  });
});
