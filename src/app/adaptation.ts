// Pure ladder state machine: paces live-capture resolution against
// the worker's actual throughput. No timers, no I/O — callers feed
// it a monotonic `now` on every live-update and get back the rung to
// send subsequent frames at.
//
// Two independent TUMBLING windows drive judgments: a short (3s)
// window governs downshifts (react fast under thermal pressure), a
// long (30s) window governs upshifts (only restore resolution once
// throughput is durably good). Each window judges once it's full,
// then resets — whether or not that judgment actually changed the
// rung — so the rate it measures is always "the last N seconds," not
// a session-lifetime average. Any downshift also resets the upshift
// window, since a rung that just dropped shouldn't be a candidate to
// immediately climb back up on stale upshift-window data. Upshifting
// only makes sense once rung > 0 (there's nowhere higher than rung 0
// to go), and at either end of the ladder a triggered shift that
// would go out of bounds just holds the rung — the window still
// resets. The gap between the two rate thresholds (4..6 updates/sec)
// is a hysteresis dead-band — inside it, neither shift fires.
export const LADDER_RUNGS = [768, 640, 512] as const;
export const DOWNSHIFT_WINDOW_MS = 3000;
export const DOWNSHIFT_BELOW_PER_SEC = 4;
export const UPSHIFT_WINDOW_MS = 30_000;
export const UPSHIFT_ABOVE_PER_SEC = 6;

export interface LadderState {
  rung: number; // index into LADDER_RUNGS
  downshiftWindowStart: number;
  downshiftUpdates: number;
  upshiftWindowStart: number;
  upshiftUpdates: number;
}

export function createLadder(now: number): LadderState {
  return {
    rung: 0,
    downshiftWindowStart: now,
    downshiftUpdates: 0,
    upshiftWindowStart: now,
    upshiftUpdates: 0,
  };
}

export function recordUpdate(
  s: LadderState,
  now: number,
): { state: LadderState; maxDimension: number; degraded: boolean } {
  let rung = s.rung;
  let downshiftWindowStart = s.downshiftWindowStart;
  let downshiftUpdates = s.downshiftUpdates + 1;
  let upshiftWindowStart = s.upshiftWindowStart;
  let upshiftUpdates = s.upshiftUpdates + 1;

  // The downshift window judges first: it's the shorter of the two,
  // and a downshift it triggers resets the upshift window below.
  const downshiftElapsedMs = now - downshiftWindowStart;
  if (downshiftElapsedMs >= DOWNSHIFT_WINDOW_MS) {
    const ratePerSec = (downshiftUpdates * 1000) / downshiftElapsedMs;
    const canDownshift = rung < LADDER_RUNGS.length - 1;
    if (ratePerSec < DOWNSHIFT_BELOW_PER_SEC && canDownshift) {
      rung += 1;
      upshiftWindowStart = now;
      upshiftUpdates = 0;
    }
    downshiftWindowStart = now;
    downshiftUpdates = 0;
  }

  const upshiftElapsedMs = now - upshiftWindowStart;
  if (upshiftElapsedMs >= UPSHIFT_WINDOW_MS) {
    const ratePerSec = (upshiftUpdates * 1000) / upshiftElapsedMs;
    if (ratePerSec > UPSHIFT_ABOVE_PER_SEC && rung > 0) {
      rung -= 1;
    }
    upshiftWindowStart = now;
    upshiftUpdates = 0;
  }

  return {
    state: {
      rung,
      downshiftWindowStart,
      downshiftUpdates,
      upshiftWindowStart,
      upshiftUpdates,
    },
    maxDimension: LADDER_RUNGS[rung],
    degraded: rung > 0,
  };
}
