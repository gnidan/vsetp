import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Frame } from "../model";
import { frameId } from "../model";
import type { LiveFrameCapture } from "./live-capture";
import type { LiveUpdate, WorkerClient } from "./worker-client";
import type { LiveDriverDeps } from "./live-driver";
import { STALL_MS, createLiveDriver } from "./live-driver";

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
    now: () => now,
    ...overrides,
  };
  return {
    deps,
    fc,
    sched,
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

  test("stall fires onStall once after STALL_MS of silence post-send", async () => {
    const { deps, sched, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(0);
    sched.fire(); // first frame sent, baseline lastSignalAt = 0
    setNow(STALL_MS + 1);
    sched.fire();
    expect(deps.onStall).toHaveBeenCalledTimes(1);
    setNow(STALL_MS * 3);
    sched.fire();
    expect(deps.onStall).toHaveBeenCalledTimes(1); // once only
  });

  test("stall stops pacing: the schedule is cancelled", async () => {
    const { deps, sched, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(0);
    sched.fire();
    setNow(STALL_MS + 1);
    sched.fire();
    expect(sched.cancel).toHaveBeenCalledTimes(1);
  });

  test("a client signal resets the stall clock", async () => {
    const { deps, fc, sched, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(0);
    sched.fire(); // baseline lastSignalAt = 0
    setNow(4000);
    fc.onSignal?.(); // resets lastSignalAt = 4000
    setNow(4000 + STALL_MS - 1);
    sched.fire();
    expect(deps.onStall).not.toHaveBeenCalled();
  });

  test("no stall while video never becomes ready (no frames sent yet)", async () => {
    const { deps, sched, setNow } = makeDeps({
      video: { videoWidth: 100, videoHeight: 100, readyState: 0 },
    });
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(0);
    sched.fire();
    setNow(STALL_MS * 10);
    sched.fire();
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
    const { deps, sched, setNow } = makeDeps();
    const driver = createLiveDriver(deps);
    await driver.start();
    setNow(0);
    sched.fire();
    setNow(STALL_MS + 1);
    sched.fire(); // stall fires, pacing stops
    expect(deps.onStall).toHaveBeenCalledTimes(1);
    await driver.stop();
    await driver.start();
    expect(sched.schedule).toHaveBeenCalledTimes(2);
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
