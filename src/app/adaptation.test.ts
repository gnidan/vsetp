import { describe, expect, test } from "vitest";
import type { LadderState } from "./adaptation";
import {
  DOWNSHIFT_WINDOW_MS,
  LADDER_RUNGS,
  UPSHIFT_WINDOW_MS,
  createLadder,
  recordUpdate,
} from "./adaptation";

describe("createLadder", () => {
  test("starts at rung 0 with an empty window", () => {
    expect(createLadder(1000)).toEqual({
      rung: 0,
      windowStart: 1000,
      updatesInWindow: 0,
    });
  });
});

interface Case {
  name: string;
  given: LadderState;
  now: number;
  expected: {
    state: LadderState;
    maxDimension: number;
    degraded: boolean;
  };
}

const CASES: Case[] = [
  {
    name: "window not yet full: no judgment even at a starving rate",
    given: { rung: 0, windowStart: 0, updatesInWindow: 0 },
    now: 1000,
    expected: {
      state: { rung: 0, windowStart: 0, updatesInWindow: 1 },
      maxDimension: 768,
      degraded: false,
    },
  },
  {
    name: "downshift: full 3s window, rate < 4/s (5 updates / 3s ~1.67/s)",
    given: { rung: 0, windowStart: 0, updatesInWindow: 4 },
    now: DOWNSHIFT_WINDOW_MS,
    expected: {
      state: { rung: 1, windowStart: 3000, updatesInWindow: 0 },
      maxDimension: 640,
      degraded: true,
    },
  },
  {
    name: "second downshift: 640 -> 512",
    given: { rung: 1, windowStart: 0, updatesInWindow: 4 },
    now: DOWNSHIFT_WINDOW_MS,
    expected: {
      state: { rung: 2, windowStart: 3000, updatesInWindow: 0 },
      maxDimension: 512,
      degraded: true,
    },
  },
  {
    name: "floor: already at 512, starving rate holds (no reset)",
    given: { rung: 2, windowStart: 0, updatesInWindow: 4 },
    now: DOWNSHIFT_WINDOW_MS,
    expected: {
      state: { rung: 2, windowStart: 0, updatesInWindow: 5 },
      maxDimension: 512,
      degraded: true,
    },
  },
  {
    name: "dead-band: rate exactly 4/s (boundary) does not downshift",
    given: { rung: 0, windowStart: 0, updatesInWindow: 11 },
    now: DOWNSHIFT_WINDOW_MS,
    expected: {
      state: { rung: 0, windowStart: 0, updatesInWindow: 12 },
      maxDimension: 768,
      degraded: false,
    },
  },
  {
    name: "dead-band: rate 5/s (between 4 and 6) holds, window keeps growing",
    given: { rung: 0, windowStart: 0, updatesInWindow: 14 },
    now: DOWNSHIFT_WINDOW_MS,
    expected: {
      state: { rung: 0, windowStart: 0, updatesInWindow: 15 },
      maxDimension: 768,
      degraded: false,
    },
  },
  {
    name: "high rate but window not yet 30s: no upshift even though > 6/s",
    given: { rung: 1, windowStart: 0, updatesInWindow: 20 },
    now: DOWNSHIFT_WINDOW_MS,
    expected: {
      state: { rung: 1, windowStart: 0, updatesInWindow: 21 },
      maxDimension: 640,
      degraded: true,
    },
  },
  {
    name: "upshift: full 30s window, rate > 6/s (210 updates / 30s = 7/s)",
    given: { rung: 1, windowStart: 0, updatesInWindow: 209 },
    now: UPSHIFT_WINDOW_MS,
    expected: {
      state: { rung: 0, windowStart: 30_000, updatesInWindow: 0 },
      maxDimension: 768,
      degraded: false,
    },
  },
  {
    name: "dead-band: rate exactly 6/s (boundary) does not upshift",
    given: { rung: 1, windowStart: 0, updatesInWindow: 179 },
    now: UPSHIFT_WINDOW_MS,
    expected: {
      state: { rung: 1, windowStart: 0, updatesInWindow: 180 },
      maxDimension: 640,
      degraded: true,
    },
  },
  {
    name: "ceiling: already at 768, a hot rate holds (no reset)",
    given: { rung: 0, windowStart: 0, updatesInWindow: 209 },
    now: UPSHIFT_WINDOW_MS,
    expected: {
      state: { rung: 0, windowStart: 0, updatesInWindow: 210 },
      maxDimension: 768,
      degraded: false,
    },
  },
  {
    name: "downshift still fires past the 30s mark when rate is < 4/s",
    given: { rung: 1, windowStart: 0, updatesInWindow: 29 },
    now: UPSHIFT_WINDOW_MS,
    expected: {
      state: { rung: 2, windowStart: 30_000, updatesInWindow: 0 },
      maxDimension: 512,
      degraded: true,
    },
  },
];

describe("recordUpdate", () => {
  test.each(CASES)("$name", ({ given, now, expected }) => {
    expect(recordUpdate(given, now)).toEqual(expected);
  });

  test("LADDER_RUNGS is 768 -> 640 -> 512", () => {
    expect(LADDER_RUNGS).toEqual([768, 640, 512]);
  });
});
