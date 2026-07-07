import type { DetectOptions } from "../vision/adapter";
import type { LadderState } from "./adaptation";
import { LADDER_RUNGS, createLadder, recordUpdate } from "./adaptation";
import type { LiveFrameCapture, VideoLike } from "./live-capture";
import type { LiveUpdate, WorkerClient } from "./worker-client";

export const STALL_MS = 5000;

// A frame is available to draw once the video reaches at least
// HAVE_CURRENT_DATA (HTMLMediaElement.readyState === 2).
const READY_STATE_HAVE_CURRENT_DATA = 2;

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

export interface LiveDriverDeps {
  client: Pick<WorkerClient, "startLive" | "sendLiveFrame" | "stopLive">;
  video: VideoLike & { readonly readyState: number };
  capture(video: VideoLike): LiveFrameCapture; // createLiveCapturer()
  onUpdate(update: LiveUpdate): void;
  onDegraded(degraded: boolean): void;
  onStall(): void;
  schedule(cb: () => void): () => void; // rVFC/rAF/interval abstraction
  now(): number;
  // Opportunistic wake lock, injectable for tests. Defaults to
  // navigator.wakeLock?.request("screen") when omitted, feature-
  // detected so the driver still runs where it's unavailable.
  requestWakeLock?(): Promise<WakeLockSentinelLike | null | undefined>;
  // Independent repeating timer that polls for a stall, injectable
  // for tests. Defaults to a plain `setInterval` wrapper. This must
  // be a *separate* timer from `schedule`: `schedule` can itself
  // freeze (a dead rVFC never fires again), and a frozen schedule
  // must still be able to report its own stall.
  repeat?(cb: () => void, ms: number): () => void;
}

// A driver that has reported a stall via `onStall()` stops pacing but
// stays `started` — it does not attempt to recover on its own. To
// resume, the caller must `stop()` then `start()` for a fresh
// session (a fresh ladder, a fresh stall clock, and a fresh
// client-side live session).
export interface LiveDriver {
  start(): Promise<void>; // startLive + begin pacing + wake lock
  stop(): Promise<void>; // stopLive + cancel pacing + release lock
}

function hasDocument(): boolean {
  return typeof document !== "undefined";
}

function defaultRepeat(cb: () => void, ms: number): () => void {
  const handle = setInterval(cb, ms);
  return () => clearInterval(handle);
}

async function defaultRequestWakeLock(): Promise<WakeLockSentinelLike | null> {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const wakeLock = (
    nav as {
      wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
    }
  )?.wakeLock;
  if (!wakeLock) return null;
  return wakeLock.request("screen");
}

export function createLiveDriver(deps: LiveDriverDeps): LiveDriver {
  const requestWakeLockImpl = deps.requestWakeLock ?? defaultRequestWakeLock;
  const repeatImpl = deps.repeat ?? defaultRepeat;

  let started = false;
  let running = false;
  let cancelTick: (() => void) | null = null;
  let cancelStallTimer: (() => void) | null = null;
  let ladder: LadderState = createLadder(deps.now());
  let currentMaxDimension: number = LADDER_RUNGS[ladder.rung];
  let degraded = false;
  let sending = false;
  let lastSignalAt: number | null = null;
  let wakeLock: WakeLockSentinelLike | null = null;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  function resetSessionState(now: number): void {
    ladder = createLadder(now);
    currentMaxDimension = LADDER_RUNGS[ladder.rung];
    degraded = false;
    sending = false;
    lastSignalAt = null;
  }

  function handleUpdate(update: LiveUpdate): void {
    // a stalled or stopping session dispatches nothing: a late
    // worker update must not resurrect UI state after onStall or
    // race a stop() already in progress
    if (!running) return;
    lastSignalAt = deps.now();
    const result = recordUpdate(ladder, deps.now());
    ladder = result.state;
    currentMaxDimension = result.maxDimension;
    if (result.degraded !== degraded) {
      degraded = result.degraded;
      deps.onDegraded(degraded);
    }
    deps.onUpdate(update);
  }

  function handleSignal(): void {
    lastSignalAt = deps.now();
  }

  function stallElapsed(): boolean {
    return (
      sending && lastSignalAt !== null && deps.now() - lastSignalAt > STALL_MS
    );
  }

  function stopStallTimer(): void {
    cancelStallTimer?.();
    cancelStallTimer = null;
  }

  function startStallTimer(): void {
    if (cancelStallTimer) return;
    cancelStallTimer = repeatImpl(checkStall, STALL_MS);
  }

  // Runs on its own `repeat` timer, independent of `tick`/`schedule`,
  // so a frozen schedule (e.g. a dead rVFC) can still be caught.
  function checkStall(): void {
    if (!running) return;
    if (stallElapsed()) {
      running = false;
      cancelTick?.();
      cancelTick = null;
      stopStallTimer();
      deps.onStall();
    }
  }

  function tick(): void {
    if (!running) return;
    if (deps.video.readyState >= READY_STATE_HAVE_CURRENT_DATA) {
      const { frame, captureMs } = deps.capture(deps.video);
      deps.client.sendLiveFrame(frame, captureMs, {
        maxDimension: currentMaxDimension,
      } satisfies DetectOptions);
      const firstSend = !sending;
      sending = true;
      if (lastSignalAt === null) lastSignalAt = deps.now();
      if (firstSend) startStallTimer();
    }
  }

  async function requestWakeLock(): Promise<void> {
    let result: WakeLockSentinelLike | null;
    try {
      result = (await requestWakeLockImpl()) ?? null;
    } catch {
      result = null;
    }
    if (!started) {
      // stop() ran while this request was in flight: drop it rather
      // than stashing a sentinel for a session that no longer exists.
      try {
        await result?.release();
      } catch {
        // opportunistic release; a failure here is not actionable
      }
      return;
    }
    const previous = wakeLock;
    wakeLock = result;
    if (previous && previous !== result) {
      // an overlapping request already holds a sentinel; release it
      // now that this (later-resolving) one is replacing it.
      try {
        await previous.release();
      } catch {
        // opportunistic release; a failure here is not actionable
      }
    }
  }

  async function releaseWakeLock(): Promise<void> {
    const held = wakeLock;
    wakeLock = null;
    try {
      await held?.release();
    } catch {
      // opportunistic release; a failure here is not actionable
    }
  }

  function onVisibilityChange(): void {
    if (started && document.visibilityState === "visible") {
      void requestWakeLock();
    }
  }

  async function start(): Promise<void> {
    if (started) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      resetSessionState(deps.now());
      await deps.client.startLive(handleUpdate, handleSignal);
      started = true;
      running = true;
      if (hasDocument()) {
        document.addEventListener("visibilitychange", onVisibilityChange);
      }
      await requestWakeLock();
      try {
        cancelTick = deps.schedule(tick);
      } catch (err) {
        cancelTick = null;
        running = false;
        if (hasDocument()) {
          document.removeEventListener("visibilitychange", onVisibilityChange);
        }
        await releaseWakeLock();
        started = false;
        throw err;
      }
    })();
    try {
      await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function stop(): Promise<void> {
    if (!started) return;
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      running = false;
      cancelTick?.();
      cancelTick = null;
      stopStallTimer();
      if (hasDocument()) {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      await releaseWakeLock();
      started = false;
      await deps.client.stopLive();
    })();
    try {
      await stopPromise;
    } finally {
      stopPromise = null;
    }
  }

  return { start, stop };
}

// Production schedule helper: prefers requestVideoFrameCallback (iOS
// >= 15.4), falls back to requestAnimationFrame, and finally to a
// plain interval. Both callback paths throttle to ~100ms via a
// timestamp check (spec budget: ≤10 frames/s — rVFC fires per camera
// frame, ~30fps, so it must skip most frames too, re-arming each
// fire so the loop stays alive). Called once by the driver; the
// returned function self-perpetuates until its cancel is invoked.
const SCHEDULE_THROTTLE_MS = 100;

export interface RVFCVideo {
  requestVideoFrameCallback?(
    cb: (now: number, metadata: unknown) => void,
  ): number;
  cancelVideoFrameCallback?(handle: number): void;
}

export function createSchedule(
  video: RVFCVideo,
): (cb: () => void) => () => void {
  if (typeof video.requestVideoFrameCallback === "function") {
    const requestFrame = video.requestVideoFrameCallback.bind(video);
    return (cb: () => void) => {
      let cancelled = false;
      let handle: number | null = null;
      // -Infinity so the very first frame ticks immediately (rVFC
      // timestamps are performance.now()-based, origin-relative)
      let lastRun = -Infinity;
      const loop = (now: number) => {
        if (cancelled) return;
        if (now - lastRun >= SCHEDULE_THROTTLE_MS) {
          lastRun = now;
          cb();
        }
        if (!cancelled) handle = requestFrame(loop);
      };
      handle = requestFrame(loop);
      return () => {
        cancelled = true;
        if (handle !== null) video.cancelVideoFrameCallback?.(handle);
      };
    };
  }
  if (typeof requestAnimationFrame === "function") {
    return (cb: () => void) => {
      let cancelled = false;
      let lastRun = 0;
      let handle = requestAnimationFrame(loop);
      function loop(t: number): void {
        if (cancelled) return;
        if (t - lastRun >= SCHEDULE_THROTTLE_MS) {
          lastRun = t;
          cb();
        }
        if (!cancelled) handle = requestAnimationFrame(loop);
      }
      return () => {
        cancelled = true;
        cancelAnimationFrame(handle);
      };
    };
  }
  return (cb: () => void) => {
    const handle = setInterval(cb, SCHEDULE_THROTTLE_MS);
    return () => clearInterval(handle);
  };
}
