import { describe, expect, test } from "vitest";
import type { Quad } from "../model";
import {
  SET_LINE_CASING,
  SET_LINE_COLORS,
  SET_LINE_DASH,
  setLineStyle,
  setLineWeights,
  triangleFor,
} from "./set-lines";

describe("setLineStyle", () => {
  test("colors cycle through the palette by set index", () => {
    for (let i = 0; i < 8; i++) {
      expect(setLineStyle(i, false).color).toBe(SET_LINE_COLORS[i % 4]);
    }
  });

  test("sets 0..3 are solid; dashes start at index 4", () => {
    for (let i = 0; i < 4; i++) {
      expect(setLineStyle(i, false).dash).toBeNull();
    }
    for (let i = 4; i < 8; i++) {
      expect(setLineStyle(i, false).dash).toBe("28 18");
    }
  });

  test("unselected sets use core 8 over casing 16", () => {
    const style = setLineStyle(0, false);
    expect(style.coreWidth).toBe(8);
    expect(style.casingWidth).toBe(16);
  });

  test("selected sets emphasize by weight: core 12, casing 20", () => {
    const style = setLineStyle(2, true);
    expect(style.coreWidth).toBe(12);
    expect(style.casingWidth).toBe(20);
    expect(style.color).toBe(SET_LINE_COLORS[2]);
  });

  test("casing color is the shared dark casing", () => {
    expect(SET_LINE_CASING).toBe("#0a1420");
  });

  test("shares the dash pattern and weights with the live path", () => {
    expect(SET_LINE_DASH).toBe("28 18");
    expect(setLineWeights(false)).toEqual({ coreWidth: 8, casingWidth: 16 });
    expect(setLineWeights(true)).toEqual({ coreWidth: 12, casingWidth: 20 });
  });
});

describe("triangleFor", () => {
  test("connects the centroids of three quads", () => {
    const square = (x: number, y: number): Quad => [
      { x, y },
      { x: x + 10, y },
      { x: x + 10, y: y + 10 },
      { x, y: y + 10 },
    ];
    expect(triangleFor([square(0, 0), square(20, 0), square(0, 20)])).toBe(
      "5,5 25,5 5,25",
    );
  });

  test("centroid averages all four corners of a skewed quad", () => {
    const skewed: Quad = [
      { x: 0, y: 0 },
      { x: 8, y: 2 },
      { x: 10, y: 10 },
      { x: 2, y: 8 },
    ];
    const flat: Quad = [
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: 100 },
    ];
    expect(triangleFor([skewed, flat, flat])).toBe("5,5 100,100 100,100");
  });
});
