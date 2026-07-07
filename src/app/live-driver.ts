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
}

export interface LiveDriver {
  start(): Promise<void>; // startLive + begin pacing + wake lock
  stop(): Promise<void>; // stopLive + cancel pacing + release lock
}

function hasDocument(): boolean {
  return typeof document !== "undefined";
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

  let started = false;
  let running = false;
  let cancelTick: (() => void) | null = null;
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

  function tick(): void {
    if (!running) return;
    if (deps.video.readyState >= READY_STATE_HAVE_CURRENT_DATA) {
      const { frame, captureMs } = deps.capture(deps.video);
      deps.client.sendLiveFrame(frame, captureMs, {
        maxDimension: currentMaxDimension,
      } satisfies DetectOptions);
      sending = true;
      if (lastSignalAt === null) lastSignalAt = deps.now();
    }
    if (stallElapsed()) {
      running = false;
      cancelTick?.();
      cancelTick = null;
      deps.onStall();
    }
  }

  async function requestWakeLock(): Promise<void> {
    try {
      wakeLock = (await requestWakeLockImpl()) ?? null;
    } catch {
      wakeLock = null;
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
      cancelTick = deps.schedule(tick);
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
// >= 15.4), falls back to requestAnimationFrame throttled to ~100ms
// via a timestamp check, and finally to a plain interval. Called
// once by the driver; the returned function self-perpetuates until
// its cancel is invoked.
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
    const requestFrame = video.requestVideoFrameCallback;
    return (cb: () => void) => {
      let cancelled = false;
      let handle: number | null = null;
      const loop = () => {
        if (cancelled) return;
        cb();
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
    const RAF_THROTTLE_MS = 100;
    return (cb: () => void) => {
      let cancelled = false;
      let lastRun = 0;
      let handle = requestAnimationFrame(loop);
      function loop(t: number): void {
        if (cancelled) return;
        if (t - lastRun >= RAF_THROTTLE_MS) {
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
    const handle = setInterval(cb, 100);
    return () => clearInterval(handle);
  };
}
