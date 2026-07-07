// Pure ladder state machine: paces live-capture resolution against
// the worker's actual throughput. No timers, no I/O — callers feed
// it a monotonic `now` on every live-update and get back the rung to
// send subsequent frames at.
//
// A full window must elapse before the ladder judges anything: a
// short (3s) window governs downshifts (react fast under thermal
// pressure), a long (30s) window governs upshifts (only restore
// resolution once throughput is durably good). The gap between the
// two rate thresholds (4..6 updates/sec) is a hysteresis dead-band —
// inside it, neither shift fires and the window just keeps
// accumulating. The window resets only when a shift actually changes
// the rung; at either end of the ladder a triggered shift that would
// go out of bounds just holds (no reset, no rung change).
export const LADDER_RUNGS = [768, 640, 512] as const;
export const DOWNSHIFT_WINDOW_MS = 3000;
export const DOWNSHIFT_BELOW_PER_SEC = 4;
export const UPSHIFT_WINDOW_MS = 30_000;
export const UPSHIFT_ABOVE_PER_SEC = 6;

export interface LadderState {
  rung: number; // index into LADDER_RUNGS
  windowStart: number;
  updatesInWindow: number;
}

export function createLadder(now: number): LadderState {
  return { rung: 0, windowStart: now, updatesInWindow: 0 };
}

export function recordUpdate(
  s: LadderState,
  now: number,
): { state: LadderState; maxDimension: number; degraded: boolean } {
  const updatesInWindow = s.updatesInWindow + 1;
  const elapsedMs = now - s.windowStart;
  // ratePerSec is only read when a guard below has already confirmed
  // elapsedMs is at least a full window (> 0), so it can't divide by
  // zero in a branch that matters.
  const ratePerSec = (updatesInWindow * 1000) / elapsedMs;

  const canDownshift =
    elapsedMs >= DOWNSHIFT_WINDOW_MS && ratePerSec < DOWNSHIFT_BELOW_PER_SEC;
  const canUpshift =
    elapsedMs >= UPSHIFT_WINDOW_MS && ratePerSec > UPSHIFT_ABOVE_PER_SEC;

  let rung = s.rung;
  let windowStart = s.windowStart;
  let nextUpdatesInWindow = updatesInWindow;

  if (canDownshift && rung < LADDER_RUNGS.length - 1) {
    rung += 1;
    windowStart = now;
    nextUpdatesInWindow = 0;
  } else if (canUpshift && rung > 0) {
    rung -= 1;
    windowStart = now;
    nextUpdatesInWindow = 0;
  }

  return {
    state: { rung, windowStart, updatesInWindow: nextUpdatesInWindow },
    maxDimension: LADDER_RUNGS[rung],
    degraded: rung > 0,
  };
}
