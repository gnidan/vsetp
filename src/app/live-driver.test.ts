import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Frame } from "../model";
import { frameId } from "../model";
import type { LiveFrameCapture } from "./live-capture";
import type { LiveUpdate, WorkerClient } from "./worker-client";
import type { LiveDriverDeps, RVFCVideo } from "./live-driver";
import { STALL_MS, createLiveDriver, createSchedule } from "./live-driver";

function frameOf(id: number): Frame {
  return { id: frameId(id), width: 2, height: 2, pixels: new ArrayBuffer(16) };
}

function updateOf(id: number): LiveUpdate {
  return { frameId: frameId(id), tracks: [], timings: {} };
}

// A fake `schedule`: called ONCE by the driver (production schedules
// self-perpetuate); the test manually fires the captured tick to
// simulate frames arriving, entirely without real timers.
function fakeSchedule() {
  let tick: (() => void) | null = null;
  const cancel = vi.fn();
  return {
    schedule: vi.fn((cb: () => void) => {
      tick = cb;
      return cancel;
    }),
    fire: () => tick?.(),
    cancel,
  };
}

// A fake `schedule` that throws on its first call (simulating a
// scheduler that fails synchronously) and behaves like a normal
// fakeSchedule on any later call.
function fakeScheduleThrowsOnce() {
  let tick: (() => void) | null = null;
  let throwNext = true;
  const cancel = vi.fn();
  return {
    schedule: vi.fn((cb: () => void) => {
      if (throwNext) {
        throwNext = false;
        throw new Error("schedule failed");
      }
      tick = cb;
      return cancel;
    }),
    fire: () => tick?.(),
    cancel,
  };
}

// A fake `repeat`: captures the callback+interval passed by the
// driver's stall timer and lets the test fire it manually, entirely
// without real timers.
function fakeRepeat() {
  let cb: (() => void) | null = null;
  let ms: number | null = null;
  const cancel = vi.fn();
  return {
    repeat: vi.fn((c: () => void, intervalMs: number) => {
      cb = c;
      ms = intervalMs;
      return cancel;
    }),
    fire: () => cb?.(),
    cancel,
    ms: () => ms,
  };
}

// Flushes a handful of microtask ticks so promise continuations that
// don't otherwise get awaited (e.g. a `void someAsyncFn()` fired from
// an event listener) get a chance to run before assertions.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function fakeCapture(): (video: unknown) => LiveFrameCapture {
  let counter = 0;
  return () => ({ frame: frameOf(++counter), captureMs: 1 });
}

function fakeClient(): {
  client: Pick<WorkerClient, "startLive" | "sendLiveFrame" | "stopLive">;
  onUpdate: ((update: LiveUpdate) => void) | null;
  onSignal: (() => void) | null;
  sent: { frame: Frame; captureMs: number; options?: unknown }[];
} {
  const state: {
    client: Pick<WorkerClient, "startLive" | "sendLiveFrame" | "stopLive">;
    onUpdate: ((update: LiveUpdate) => void) | null;
    onSignal: (() => void) | null;
    sent: { frame: Frame; captureMs: number; options?: unknown }[];
  } = {
    onUpdate: null,
    onSignal: null,
    sent: [],
    client: {
      startLive: vi.fn((onUpdate, onSignal) => {
        state.onUpdate = onUpdate;
        state.onSignal = onSignal ?? null;
        return Promise.resolve();
      }),
      sendLiveFrame: vi.fn((frame, captureMs, options) => {
        state.sent.push({ frame, captureMs, options });
      }),
      stopLive: vi.fn(() => Promise.resolve()),
    },
  };
  return state;
}

function makeDeps(overrides: Partial<LiveDriverDeps> = {}) {
  const sched = fakeSchedule();
  const rep = fakeRepeat();
  const fc = fakeClient();
  let now = 0;
  const deps: LiveDriverDeps = {
    client: fc.client,
    video: { videoWidth: 100, videoHeight: 100, readyState: 4 },
    capture: fakeCapture(),
    onUpdate: vi.fn(),
    onDegraded: vi.fn(),
    onStall: vi.fn(),
    schedule: sched.schedule,
    repeat: rep.repeat,
    now: () => now,
    ...overrides,
  };
  return {
    deps,
    fc,
    sched,
    rep,
    setNow: (t: number) => {
      now = t;
    },
  };
}

describe("createLiveDriver", () => {
  test("start() awaits client.startLive and begins scheduling", async () => {
    const { deps, fc, sched } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    expect(fc.client.startLive).toHaveBeenCalledTimes(1);
    expect(sched.schedule).toHaveBeenCalledTimes(1);
  });

  test("each tick sends a frame with the ladder's current maxDimension", async () => {
    const { deps, fc, sched } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    sched.fire();
    sched.fire();
    expect(fc.sent).toHaveLength(2);
    expect(fc.sent[0].options).toEqual({ maxDimension: 768 });
  });

  test("a tick with video not ready sends no frame", async () => {
    const { deps, fc, sched } = makeDeps({
      video: { videoWidth: 100, videoHeight: 100, readyState: 0 },
    });
    const driver = createLiveDriver(deps);
    await driver.start();
    sched.fire();
    expect(fc.sent).toHaveLength(0);
  });

  test("downshift after a starving 3s window emits onDegraded(true)", async () => {
    const { deps, fc, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(3000);
    fc.onUpdate?.(updateOf(1));
    fc.onUpdate?.(updateOf(2));
    fc.onUpdate?.(updateOf(3));
    fc.onUpdate?.(updateOf(4));
    fc.onUpdate?.(updateOf(5));
    expect(deps.onDegraded).toHaveBeenCalledWith(true);
    expect(deps.onDegraded).toHaveBeenCalledTimes(1);
  });

  test("onDegraded is not re-fired for a second downshift (still degraded)", async () => {
    const { deps, fc, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(3000);
    for (let i = 1; i <= 5; i++) fc.onUpdate?.(updateOf(i));
    expect(deps.onDegraded).toHaveBeenCalledTimes(1);
    setNow(6000);
    for (let i = 6; i <= 10; i++) fc.onUpdate?.(updateOf(i));
    // still degraded (rung 2 now): boolean didn't flip, no 2nd call
    expect(deps.onDegraded).toHaveBeenCalledTimes(1);
  });

  test("frames sent after a downshift use the new rung's maxDimension", async () => {
    const { deps, fc, sched, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(3000);
    for (let i = 1; i <= 5; i++) fc.onUpdate?.(updateOf(i));
    sched.fire();
    expect(fc.sent[0].options).toEqual({ maxDimension: 640 });
  });

  test("onUpdate forwards the update to the caller", async () => {
    const { deps, fc } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    const update = updateOf(1);
    fc.onUpdate?.(update);
    expect(deps.onUpdate).toHaveBeenCalledWith(update);
  });

  // The stall check runs on its own injectable `repeat` timer, not
  // inside tick() — a schedule that has frozen (e.g. a dead rVFC)
  // must still be able to report its own stall, which it couldn't if
  // the check only ran when tick() happened to fire.
  test("stall timer starts on the first frame sent, at STALL_MS", async () => {
    const { deps, sched, rep, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    expect(rep.repeat).not.toHaveBeenCalled();
    setNow(0);
    sched.fire(); // first frame sent
    expect(rep.repeat).toHaveBeenCalledTimes(1);
    expect(rep.ms()).toBe(STALL_MS);
  });

  test("stall fires onStall once at STALL_MS via the repeat timer", async () => {
    const { deps, sched, rep, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(0);
    sched.fire(); // first frame sent, baseline lastSignalAt = 0, starts timer
    setNow(STALL_MS + 1);
    // the schedule itself never ticks again (frozen), but the
    // independent repeat timer still fires
    rep.fire();
    expect(deps.onStall).toHaveBeenCalledTimes(1);
    setNow(STALL_MS * 3);
    rep.fire();
    expect(deps.onStall).toHaveBeenCalledTimes(1); // once only
  });

  test("stall stops pacing: the schedule is cancelled", async () => {
    const { deps, sched, rep, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(0);
    sched.fire();
    setNow(STALL_MS + 1);
    rep.fire();
    expect(sched.cancel).toHaveBeenCalledTimes(1);
  });

  test("stall timer is cancelled once it fires (no self re-fire)", async () => {
    const { deps, sched, rep, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(0);
    sched.fire();
    setNow(STALL_MS + 1);
    rep.fire();
    expect(rep.cancel).toHaveBeenCalledTimes(1);
  });

  test("a client signal resets the stall clock", async () => {
    const { deps, fc, sched, rep, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(0);
    sched.fire(); // baseline lastSignalAt = 0, starts the stall timer
    setNow(4000);
    fc.onSignal?.(); // resets lastSignalAt = 4000
    setNow(4000 + STALL_MS - 1);
    rep.fire();
    expect(deps.onStall).not.toHaveBeenCalled();
  });

  test("no stall timer starts while video never becomes ready", async () => {
    const { deps, sched, rep, setNow } = makeDeps({
      video: { videoWidth: 100, videoHeight: 100, readyState: 0 },
    });
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(0);
    sched.fire();
    setNow(STALL_MS * 10);
    sched.fire();
    expect(rep.repeat).not.toHaveBeenCalled();
    expect(deps.onStall).not.toHaveBeenCalled();
  });

  test("stop() cancels a running stall timer", async () => {
    const { deps, sched, rep } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    sched.fire(); // starts the stall timer
    await driver.stop();
    expect(rep.cancel).toHaveBeenCalledTimes(1);
  });

  test("a late update after a stall never reaches onUpdate", async () => {
    const { deps, fc, sched, rep, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(0);
    sched.fire();
    setNow(STALL_MS + 1);
    rep.fire(); // stall reported; the driver stops dispatching
    expect(deps.onStall).toHaveBeenCalledTimes(1);
    fc.onUpdate?.(updateOf(1));
    expect(deps.onUpdate).not.toHaveBeenCalled();
    expect(deps.onDegraded).not.toHaveBeenCalled();
  });

  test("a late update after stop() never reaches onUpdate", async () => {
    const { deps, fc } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    await driver.stop();
    fc.onUpdate?.(updateOf(1));
    expect(deps.onUpdate).not.toHaveBeenCalled();
  });

  test("stall timer does not fire after stop()", async () => {
    const { deps, sched, rep, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(0);
    sched.fire();
    await driver.stop();
    setNow(STALL_MS + 1);
    rep.fire(); // a stray fire after stop() must be a no-op
    expect(deps.onStall).not.toHaveBeenCalled();
  });

  test("stop() awaits client.stopLive and cancels the schedule", async () => {
    const { deps, fc, sched } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    await driver.stop();
    expect(fc.client.stopLive).toHaveBeenCalledTimes(1);
    expect(sched.cancel).toHaveBeenCalledTimes(1);
  });

  test("start() is idempotent: a second call does not restart the client", async () => {
    const { deps, fc } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    await driver.start();
    expect(fc.client.startLive).toHaveBeenCalledTimes(1);
  });

  test("stop() is idempotent: a second call does not double-stop", async () => {
    const { deps, fc } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    await driver.stop();
    await driver.stop();
    expect(fc.client.stopLive).toHaveBeenCalledTimes(1);
  });

  test("stop() before any start() is a no-op", async () => {
    const { deps, fc } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.stop();
    expect(fc.client.stopLive).not.toHaveBeenCalled();
  });

  test("start-after-stop begins a fresh session (ladder resets to 768)", async () => {
    const { deps, fc, sched, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(3000);
    for (let i = 1; i <= 5; i++) fc.onUpdate?.(updateOf(i)); // downshift
    await driver.stop();
    setNow(10_000);
    await driver.start();
    sched.fire();
    expect(fc.sent[fc.sent.length - 1].options).toEqual({
      maxDimension: 768,
    });
  });

  test("start-after-stop resumes pacing after a stall stopped it", async () => {
    const { deps, sched, rep, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(0);
    sched.fire();
    setNow(STALL_MS + 1);
    rep.fire(); // stall fires, pacing stops
    expect(deps.onStall).toHaveBeenCalledTimes(1);
    await driver.stop();
    await driver.start();
    expect(sched.schedule).toHaveBeenCalledTimes(2);
  });

  test("start unwinds fully if deps.schedule throws, and a retry works", async () => {
    const release = vi.fn(() => Promise.resolve());
    const requestWakeLock = vi.fn(() => Promise.resolve({ release }));
    const sched = fakeScheduleThrowsOnce();
    const { deps, fc } = makeDeps({
      requestWakeLock,
      schedule: sched.schedule,
    });
    const driver = createLiveDriver(deps);

    await expect(driver.start()).rejects.toThrow("schedule failed");
    // unwound: wake lock released, so a retry isn't a silent no-op
    expect(release).toHaveBeenCalledTimes(1);

    await expect(driver.start()).resolves.toBeUndefined();
    expect(fc.client.startLive).toHaveBeenCalledTimes(2);
    expect(sched.schedule).toHaveBeenCalledTimes(2);

    sched.fire();
    expect(fc.sent).toHaveLength(1);
  });

  test("requests a wake lock on start and releases it on stop", async () => {
    const release = vi.fn(() => Promise.resolve());
    const requestWakeLock = vi.fn(() => Promise.resolve({ release }));
    const { deps } = makeDeps({ requestWakeLock });
    const driver = createLiveDriver(deps);
    await driver.start();
    expect(requestWakeLock).toHaveBeenCalledTimes(1);
    await driver.stop();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("wake lock request failure is swallowed silently", async () => {
    const requestWakeLock = vi.fn(() => Promise.reject(new Error("nope")));
    const { deps } = makeDeps({ requestWakeLock });
    const driver = createLiveDriver(deps);
    await expect(driver.start()).resolves.toBeUndefined();
  });

  test("wake lock release failure is swallowed silently", async () => {
    const release = vi.fn(() => Promise.reject(new Error("nope")));
    const requestWakeLock = vi.fn(() => Promise.resolve({ release }));
    const { deps } = makeDeps({ requestWakeLock });
    const driver = createLiveDriver(deps);
    await driver.start();
    await expect(driver.stop()).resolves.toBeUndefined();
  });

  test("re-requests the wake lock on visibilitychange to visible", async () => {
    const listenerBox: { current: (() => void) | null } = { current: null };
    const fakeDocument = {
      visibilityState: "visible" as string,
      addEventListener: vi.fn((_event: string, cb: () => void) => {
        listenerBox.current = cb;
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("document", fakeDocument);
    try {
      const requestWakeLock = vi.fn(() =>
        Promise.resolve({ release: vi.fn() }),
      );
      const { deps } = makeDeps({ requestWakeLock });
      const driver = createLiveDriver(deps);
      await driver.start();
      expect(requestWakeLock).toHaveBeenCalledTimes(1);
      fakeDocument.visibilityState = "visible";
      listenerBox.current?.();
      await Promise.resolve();
      expect(requestWakeLock).toHaveBeenCalledTimes(2);
      await driver.stop();
      expect(fakeDocument.removeEventListener).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a visibilitychange wake-lock request in flight during stop() is dropped", async () => {
    const listenerBox: { current: (() => void) | null } = { current: null };
    const fakeDocument = {
      visibilityState: "visible" as string,
      addEventListener: vi.fn((_event: string, cb: () => void) => {
        listenerBox.current = cb;
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("document", fakeDocument);
    try {
      const initialRelease = vi.fn(() => Promise.resolve());
      const staleRelease = vi.fn(() => Promise.resolve());
      let resolveInFlight!: (v: { release: () => Promise<void> }) => void;
      const requestWakeLock = vi
        .fn()
        .mockResolvedValueOnce({ release: initialRelease })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveInFlight = resolve;
            }),
        );
      const { deps } = makeDeps({ requestWakeLock });
      const driver = createLiveDriver(deps);
      await driver.start();
      listenerBox.current?.(); // kicks off the in-flight re-request
      await driver.stop(); // started flips false while it's pending
      expect(initialRelease).toHaveBeenCalledTimes(1);

      resolveInFlight({ release: staleRelease });
      await flush();

      // the request resolved after stop(): its sentinel must be
      // released, not stashed as the driver's (now nonexistent) lock
      expect(staleRelease).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("an overlapping wake-lock request releases the sentinel it replaces", async () => {
    const listenerBox: { current: (() => void) | null } = { current: null };
    const fakeDocument = {
      visibilityState: "visible" as string,
      addEventListener: vi.fn((_event: string, cb: () => void) => {
        listenerBox.current = cb;
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("document", fakeDocument);
    try {
      const initialRelease = vi.fn(() => Promise.resolve());
      const firstRelease = vi.fn(() => Promise.resolve());
      const secondRelease = vi.fn(() => Promise.resolve());
      let resolveFirst!: (v: { release: () => Promise<void> }) => void;
      let resolveSecond!: (v: { release: () => Promise<void> }) => void;
      const requestWakeLock = vi
        .fn()
        .mockResolvedValueOnce({ release: initialRelease })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecond = resolve;
            }),
        );
      const { deps } = makeDeps({ requestWakeLock });
      const driver = createLiveDriver(deps);
      await driver.start(); // holds the initial sentinel
      listenerBox.current?.(); // in-flight request #1
      listenerBox.current?.(); // in-flight request #2, overlaps #1

      // #2 resolves first (out of order): it replaces the initial
      // sentinel, which must be released as it's overwritten
      resolveSecond({ release: secondRelease });
      await flush();
      expect(initialRelease).toHaveBeenCalledTimes(1);

      // #1 resolves last: it replaces #2's still-held sentinel, which
      // must likewise be released before being overwritten
      resolveFirst({ release: firstRelease });
      await flush();
      expect(secondRelease).toHaveBeenCalledTimes(1);
      expect(firstRelease).not.toHaveBeenCalled();

      await driver.stop();
      expect(firstRelease).toHaveBeenCalledTimes(1); // the current lock
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// A fake rVFC video: captures the pending frame callback so the test
// can fire it with explicit timestamps, simulating a camera that
// delivers frames much faster than the frame budget.
function fakeRvfcVideo() {
  let pending: ((now: number, metadata: unknown) => void) | null = null;
  let handle = 0;
  const cancelled: number[] = [];
  return {
    video: {
      requestVideoFrameCallback(cb: (now: number, metadata: unknown) => void) {
        pending = cb;
        return ++handle;
      },
      cancelVideoFrameCallback(h: number) {
        cancelled.push(h);
      },
    } satisfies RVFCVideo,
    fire(now: number) {
      const cb = pending;
      pending = null;
      cb?.(now, {});
    },
    hasPending: () => pending !== null,
    cancelled,
  };
}

describe("createSchedule", () => {
  test("calls requestVideoFrameCallback bound to the video (not detached)", () => {
    let receivedThis: unknown;
    const video: RVFCVideo = {
      requestVideoFrameCallback(_cb) {
        receivedThis = this;
        return 1;
      },
      cancelVideoFrameCallback: vi.fn(),
    };
    const schedule = createSchedule(video);
    schedule(() => {});
    expect(receivedThis).toBe(video);
  });

  test("rVFC path throttles a ~30fps camera to ≤1 tick per 100ms", () => {
    const rvfc = fakeRvfcVideo();
    const schedule = createSchedule(rvfc.video);
    const tickTimes: number[] = [];
    let now = 0;
    schedule(() => tickTimes.push(now));
    // frames every 33ms for a full second: 31 fires, but only fires
    // landing ≥100ms after the last invoked tick may invoke — every
    // consecutive pair of ticks must be ≥100ms apart (≤10 ticks/s)
    for (now = 0; now <= 1000; now += 33) rvfc.fire(now);
    for (let i = 1; i < tickTimes.length; i++) {
      expect(tickTimes[i] - tickTimes[i - 1]).toBeGreaterThanOrEqual(100);
    }
    // 0, 132, 264, …: 8 ticks — well under the 10/s budget, and far
    // below the 31 a per-frame rVFC would have delivered
    expect(tickTimes.length).toBeLessThanOrEqual(10);
    expect(tickTimes.length).toBeGreaterThanOrEqual(8);
  });

  test("rVFC path invokes the very first frame immediately", () => {
    const rvfc = fakeRvfcVideo();
    const schedule = createSchedule(rvfc.video);
    const tick = vi.fn();
    schedule(tick);
    rvfc.fire(0);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  test("rVFC path re-arms after a skipped frame (loop stays alive)", () => {
    const rvfc = fakeRvfcVideo();
    const schedule = createSchedule(rvfc.video);
    const tick = vi.fn();
    schedule(tick);
    rvfc.fire(0); // ticks
    rvfc.fire(33); // skipped (within the 100ms window)
    expect(tick).toHaveBeenCalledTimes(1);
    expect(rvfc.hasPending()).toBe(true); // still re-armed
    rvfc.fire(100); // window elapsed
    expect(tick).toHaveBeenCalledTimes(2);
  });

  test("rVFC path stops firing and cancels once cancelled", () => {
    const rvfc = fakeRvfcVideo();
    const schedule = createSchedule(rvfc.video);
    const tick = vi.fn();
    const cancel = schedule(tick);
    rvfc.fire(0);
    cancel();
    expect(rvfc.cancelled.length).toBeGreaterThan(0);
    rvfc.fire(500); // a stray late fire must not tick
    expect(tick).toHaveBeenCalledTimes(1);
  });
});

describe("createLiveDriver production defaults", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  test("works with no document/navigator present (Node test env)", async () => {
    const { deps } = makeDeps();
    delete (deps as { requestWakeLock?: unknown }).requestWakeLock;
    const driver = createLiveDriver(deps);
    await expect(driver.start()).resolves.toBeUndefined();
    await expect(driver.stop()).resolves.toBeUndefined();
  });
});
