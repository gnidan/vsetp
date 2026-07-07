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
  test("starts at rung 0 with both windows empty", () => {
    expect(createLadder(1000)).toEqual({
      rung: 0,
      downshiftWindowStart: 1000,
      downshiftUpdates: 0,
      upshiftWindowStart: 1000,
      upshiftUpdates: 0,
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
    given: {
      rung: 0,
      downshiftWindowStart: 0,
      downshiftUpdates: 0,
      upshiftWindowStart: 0,
      upshiftUpdates: 0,
    },
    now: 1000,
    expected: {
      state: {
        rung: 0,
        downshiftWindowStart: 0,
        downshiftUpdates: 1,
        upshiftWindowStart: 0,
        upshiftUpdates: 1,
      },
      maxDimension: 768,
      degraded: false,
    },
  },
  {
    name: "downshift: full 3s window, rate < 4/s (5 updates / 3s ~1.67/s)",
    given: {
      rung: 0,
      downshiftWindowStart: 0,
      downshiftUpdates: 4,
      upshiftWindowStart: 0,
      upshiftUpdates: 4,
    },
    now: DOWNSHIFT_WINDOW_MS,
    expected: {
      state: {
        rung: 1,
        downshiftWindowStart: 3000,
        downshiftUpdates: 0,
        // a downshift also resets the (independent) upshift window
        upshiftWindowStart: 3000,
        upshiftUpdates: 0,
      },
      maxDimension: 640,
      degraded: true,
    },
  },
  {
    name: "second downshift: 640 -> 512",
    given: {
      rung: 1,
      downshiftWindowStart: 0,
      downshiftUpdates: 4,
      upshiftWindowStart: 0,
      upshiftUpdates: 4,
    },
    now: DOWNSHIFT_WINDOW_MS,
    expected: {
      state: {
        rung: 2,
        downshiftWindowStart: 3000,
        downshiftUpdates: 0,
        upshiftWindowStart: 3000,
        upshiftUpdates: 0,
      },
      maxDimension: 512,
      degraded: true,
    },
  },
  {
    name: "floor: already at 512, starving rate still tumbles the window",
    given: {
      rung: 2,
      downshiftWindowStart: 0,
      downshiftUpdates: 4,
      upshiftWindowStart: 0,
      upshiftUpdates: 4,
    },
    now: DOWNSHIFT_WINDOW_MS,
    expected: {
      state: {
        rung: 2,
        // the downshift window is tumbling: it resets on every full
        // judgment, shift or no shift, so it resets here even though
        // the rung can't go any lower. The upshift window is untouched
        // because no rung change actually happened.
        downshiftWindowStart: 3000,
        downshiftUpdates: 0,
        upshiftWindowStart: 0,
        upshiftUpdates: 5,
      },
      maxDimension: 512,
      degraded: true,
    },
  },
  {
    name: "dead-band: rate exactly 4/s (boundary) does not downshift",
    given: {
      rung: 0,
      downshiftWindowStart: 0,
      downshiftUpdates: 11,
      upshiftWindowStart: 0,
      upshiftUpdates: 11,
    },
    now: DOWNSHIFT_WINDOW_MS,
    expected: {
      state: {
        rung: 0,
        downshiftWindowStart: 3000,
        downshiftUpdates: 0,
        upshiftWindowStart: 0,
        upshiftUpdates: 12,
      },
      maxDimension: 768,
      degraded: false,
    },
  },
  {
    name: "dead-band: rate 5/s (between 4 and 6) holds, window still tumbles",
    given: {
      rung: 0,
      downshiftWindowStart: 0,
      downshiftUpdates: 14,
      upshiftWindowStart: 0,
      upshiftUpdates: 14,
    },
    now: DOWNSHIFT_WINDOW_MS,
    expected: {
      state: {
        rung: 0,
        downshiftWindowStart: 3000,
        downshiftUpdates: 0,
        upshiftWindowStart: 0,
        upshiftUpdates: 15,
      },
      maxDimension: 768,
      degraded: false,
    },
  },
  {
    name: "high rate but the 3s downshift window still judges (no shift)",
    given: {
      rung: 1,
      downshiftWindowStart: 0,
      downshiftUpdates: 20,
      upshiftWindowStart: 0,
      upshiftUpdates: 20,
    },
    now: DOWNSHIFT_WINDOW_MS,
    expected: {
      state: {
        rung: 1,
        downshiftWindowStart: 3000,
        downshiftUpdates: 0,
        upshiftWindowStart: 0,
        upshiftUpdates: 21,
      },
      maxDimension: 640,
      degraded: true,
    },
  },
  {
    name: "upshift: full 30s window, rate > 6/s (210 updates / 30s = 7/s)",
    given: {
      rung: 1,
      downshiftWindowStart: 30_000,
      downshiftUpdates: 0,
      upshiftWindowStart: 0,
      upshiftUpdates: 209,
    },
    now: UPSHIFT_WINDOW_MS,
    expected: {
      state: {
        rung: 0,
        downshiftWindowStart: 30_000,
        downshiftUpdates: 1,
        upshiftWindowStart: 30_000,
        upshiftUpdates: 0,
      },
      maxDimension: 768,
      degraded: false,
    },
  },
  {
    name: "dead-band: rate exactly 6/s (boundary) does not upshift",
    given: {
      rung: 1,
      downshiftWindowStart: 30_000,
      downshiftUpdates: 0,
      upshiftWindowStart: 0,
      upshiftUpdates: 179,
    },
    now: UPSHIFT_WINDOW_MS,
    expected: {
      state: {
        rung: 1,
        downshiftWindowStart: 30_000,
        downshiftUpdates: 1,
        upshiftWindowStart: 30_000,
        upshiftUpdates: 0,
      },
      maxDimension: 640,
      degraded: true,
    },
  },
  {
    name: "ceiling: already at 768, a hot rate still tumbles the window",
    given: {
      rung: 0,
      downshiftWindowStart: 30_000,
      downshiftUpdates: 0,
      upshiftWindowStart: 0,
      upshiftUpdates: 209,
    },
    now: UPSHIFT_WINDOW_MS,
    expected: {
      state: {
        rung: 0,
        downshiftWindowStart: 30_000,
        downshiftUpdates: 1,
        upshiftWindowStart: 30_000,
        upshiftUpdates: 0,
      },
      maxDimension: 768,
      degraded: false,
    },
  },
  {
    name: "downshift fires on its own 3s cadence regardless of upshift age",
    given: {
      rung: 1,
      downshiftWindowStart: 0,
      downshiftUpdates: 29,
      upshiftWindowStart: 0,
      upshiftUpdates: 29,
    },
    now: UPSHIFT_WINDOW_MS,
    expected: {
      state: {
        rung: 2,
        downshiftWindowStart: 30_000,
        downshiftUpdates: 0,
        // the downshift resets the upshift window too, so the upshift
        // check that would otherwise fire at exactly the 30s mark is
        // pre-empted
        upshiftWindowStart: 30_000,
        upshiftUpdates: 0,
      },
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

describe("ladder trace: tumbling windows react to a real collapse", () => {
  test("600s healthy at 10/s then collapse to 1/s downshifts fast", () => {
    let state = createLadder(0);
    let now = 0;

    const HEALTHY_INTERVAL_MS = 100; // 10 updates/sec
    const HEALTHY_DURATION_MS = 600_000; // 600s of healthy throughput
    while (now < HEALTHY_DURATION_MS) {
      now += HEALTHY_INTERVAL_MS;
      state = recordUpdate(state, now).state;
    }
    expect(state.rung).toBe(0); // still healthy after 10 minutes

    const collapseStart = now;
    const UNHEALTHY_INTERVAL_MS = 1000; // 1 update/sec
    let downshiftedAt: number | null = null;
    for (let i = 0; i < 10 && downshiftedAt === null; i++) {
      now += UNHEALTHY_INTERVAL_MS;
      state = recordUpdate(state, now).state;
      if (state.rung > 0) downshiftedAt = now;
    }

    expect(downshiftedAt).not.toBeNull();
    // With a session-lifetime average this takes ~20 minutes; with
    // tumbling 3s downshift windows it must react within a couple of
    // windows of the collapse starting.
    expect(downshiftedAt! - collapseStart).toBeLessThanOrEqual(
      2 * DOWNSHIFT_WINDOW_MS,
    );
  });
});
