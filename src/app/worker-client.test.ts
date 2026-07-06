import { beforeEach, describe, expect, test, vi } from "vitest";
import { frameId } from "../model";
import type { Frame, FrameAnalysis } from "../model";
import type { WorkerRequest, WorkerResponse } from "../worker/protocol";
import {
  AnalyzeError,
  AnalyzeTimeoutError,
  DisposedError,
  LiveSessionError,
  WorkerDiedError,
  createWorkerClient,
} from "./worker-client";
import type { LiveUpdate, WorkerLike } from "./worker-client";

class FakeWorker implements WorkerLike {
  sent: { message: WorkerRequest; transfer?: Transferable[] }[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  terminated = false;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.sent.push({ message: message as WorkerRequest, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(response: WorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent);
  }
}

function frameOf(id: number): Frame {
  return {
    id: frameId(id),
    width: 2,
    height: 2,
    pixels: new ArrayBuffer(16),
  };
}

function analysisOf(id: number): FrameAnalysis {
  return {
    frameId: frameId(id),
    frameSize: { width: 2, height: 2 },
    cards: [],
    timings: {},
  };
}

let worker: FakeWorker;
const client = () =>
  createWorkerClient({
    createWorker: () => worker,
    wasmUrl: "/vendor/test.js",
    timeoutMs: 50,
  });

beforeEach(() => {
  worker = new FakeWorker();
});

describe("error classes", () => {
  test("DisposedError has correct name property", () => {
    expect(new DisposedError("test").name).toBe("DisposedError");
  });
});

describe("init", () => {
  test("posts init once, resolves on ready, reports progress", async () => {
    const c = client();
    const progress = vi.fn();
    const first = c.init(progress);
    const second = c.init(); // idempotent
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0].message).toEqual({
      type: "init",
      wasmUrl: "/vendor/test.js",
    });
    worker.emit({ type: "init-progress", loaded: 5, total: 10 });
    worker.emit({ type: "ready" });
    await Promise.all([first, second]);
    expect(progress).toHaveBeenCalledWith(5, 10);
  });

  test("re-registering the same progress callback does not duplicate", async () => {
    const c = client();
    const progress = vi.fn();
    const first = c.init(progress);
    void c.init(progress); // same callback again
    worker.emit({ type: "init-progress", loaded: 1, total: 2 });
    worker.emit({ type: "ready" });
    await first;
    expect(progress).toHaveBeenCalledTimes(1);
  });

  test("rejects on init-error", async () => {
    const c = client();
    const initialized = c.init();
    worker.emit({ type: "init-error", message: "no wasm" });
    await expect(initialized).rejects.toThrow(/no wasm/);
  });
});

describe("analyze", () => {
  async function readyClient() {
    const c = client();
    const initialized = c.init();
    worker.emit({ type: "ready" });
    await initialized;
    return c;
  }

  test("transfers a copy of the pixels, preserving the source frame", async () => {
    const c = await readyClient();
    const frame = frameOf(7);
    const resulted = c.analyze(frame);
    const sent = worker.sent[1];
    expect(sent.message.type).toBe("analyze");
    if (sent.message.type !== "analyze") throw new Error("unreachable");
    // the posted frame carries its own buffer (transferred), so the
    // caller's frame stays usable for re-analyze
    expect(sent.transfer).toEqual([sent.message.frame.pixels]);
    expect(sent.message.frame.pixels).not.toBe(frame.pixels);
    expect(frame.pixels.byteLength).toBe(16); // not detached
    worker.emit({
      type: "result",
      frameId: frameId(7),
      analysis: analysisOf(7),
    });
    await expect(resulted).resolves.toEqual({
      status: "ok",
      analysis: analysisOf(7),
    });
  });

  test("resolves superseded on dropped", async () => {
    const c = await readyClient();
    const resulted = c.analyze(frameOf(8));
    worker.emit({ type: "dropped", frameId: frameId(8) });
    await expect(resulted).resolves.toEqual({ status: "superseded" });
  });

  test("rejects AnalyzeError with stage on analyze-error", async () => {
    const c = await readyClient();
    const resulted = c.analyze(frameOf(9));
    worker.emit({
      type: "analyze-error",
      frameId: frameId(9),
      stage: "segment",
      message: "boom",
    });
    await expect(resulted).rejects.toBeInstanceOf(AnalyzeError);
    await expect(resulted).rejects.toMatchObject({ stage: "segment" });
  });

  test("worker death rejects all in-flight promises", async () => {
    const c = await readyClient();
    const resulted = c.analyze(frameOf(10));
    worker.onerror?.(new Event("error"));
    await expect(resulted).rejects.toBeInstanceOf(WorkerDiedError);
    await expect(c.analyze(frameOf(11))).rejects.toBeInstanceOf(
      WorkerDiedError,
    );
  });

  test("watchdog timeout rejects and fails the client", async () => {
    vi.useFakeTimers();
    try {
      const c = await readyClient();
      const resulted = c.analyze(frameOf(12));
      const expectation =
        expect(resulted).rejects.toBeInstanceOf(AnalyzeTimeoutError);
      await vi.advanceTimersByTimeAsync(51);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  test("dispose terminates and rejects in-flight with DisposedError", async () => {
    const c = await readyClient();
    const resulted = c.analyze(frameOf(13));
    c.dispose();
    expect(worker.terminated).toBe(true);
    await expect(resulted).rejects.toBeInstanceOf(DisposedError);
  });
});

describe("live", () => {
  async function readyClient() {
    const c = client();
    const initialized = c.init();
    worker.emit({ type: "ready" });
    await initialized;
    return c;
  }

  async function liveClient(onUpdate: (u: LiveUpdate) => void = () => {}) {
    const c = await readyClient();
    const started = c.startLive(onUpdate);
    worker.emit({ type: "live-ready" });
    await started;
    return c;
  }

  test("startLive resolves on live-ready and routes live-updates", async () => {
    const updates: LiveUpdate[] = [];
    await liveClient((u) => updates.push(u));
    expect(worker.sent[1].message).toEqual({ type: "live-start" });
    worker.emit({
      type: "live-update",
      frameId: frameId(1),
      tracks: [],
      timings: { capture: 4 },
    });
    expect(updates).toEqual([
      { frameId: frameId(1), tracks: [], timings: { capture: 4 } },
    ]);
  });

  test("sendLiveFrame transfers the buffer (no slice)", async () => {
    const c = await liveClient();
    const frame = frameOf(3);
    c.sendLiveFrame(frame, 6);
    const sent = worker.sent[2];
    expect(sent.message.type).toBe("live-frame");
    if (sent.message.type !== "live-frame") throw new Error("unreachable");
    // live frames are minted fresh per capture: the client transfers
    // the caller's buffer itself, not a copy
    expect(sent.message.frame.pixels).toBe(frame.pixels);
    expect(sent.transfer).toEqual([frame.pixels]);
    expect(sent.message.captureMs).toBe(6);
  });

  test("analyze rejects with LiveSessionError while live", async () => {
    const c = await liveClient();
    await expect(c.analyze(frameOf(4))).rejects.toBeInstanceOf(
      LiveSessionError,
    );
  });

  test("startLive rejects while an analyze is pending", async () => {
    const c = await readyClient();
    const resulted = c.analyze(frameOf(5));
    await expect(c.startLive(() => {})).rejects.toBeInstanceOf(
      LiveSessionError,
    );
    worker.emit({
      type: "result",
      frameId: frameId(5),
      analysis: analysisOf(5),
    });
    await resulted;
  });

  test("sendMark resolves on mark-ack with the same markId", async () => {
    const c = await liveClient();
    const acked = c.sendMark({ type: "missed-card", at: { x: 1, y: 2 } });
    const sent = worker.sent[2].message;
    expect(sent.type).toBe("live-feedback");
    if (sent.type !== "live-feedback") throw new Error("unreachable");
    worker.emit({ type: "mark-ack", markId: sent.markId });
    await expect(acked).resolves.toBeUndefined();
  });

  test("stopLive resolves on live-stopped and re-enables analyze", async () => {
    const c = await liveClient();
    const stopped = c.stopLive();
    worker.emit({ type: "live-stopped" });
    await stopped;
    const resulted = c.analyze(frameOf(6));
    worker.emit({
      type: "result",
      frameId: frameId(6),
      analysis: analysisOf(6),
    });
    await expect(resulted).resolves.toEqual({
      status: "ok",
      analysis: analysisOf(6),
    });
  });

  test("failAll rejects pending mark and stop promises", async () => {
    const c = await liveClient();
    const acked = c.sendMark({ type: "not-a-card", at: { x: 1, y: 2 } });
    const stopped = c.stopLive();
    worker.onerror?.(new Event("error"));
    await expect(acked).rejects.toBeInstanceOf(WorkerDiedError);
    await expect(stopped).rejects.toBeInstanceOf(WorkerDiedError);
  });
});
