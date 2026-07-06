import type {
  Frame,
  FrameAnalysis,
  FrameId,
  Mark,
  MarkId,
  Track,
} from "../model";
import { markId } from "../model";
import type { DetectOptions } from "../vision/adapter";
import { OPENCV_VENDOR_FILE } from "../vision/opencv/cv";
import type { PipelineStage, RequestKind, RequestOf } from "../worker/protocol";
import { isWorkerResponse } from "../worker/protocol";

export const ANALYZE_TIMEOUT_MS = 30_000;

export type AnalyzeResult =
  { status: "ok"; analysis: FrameAnalysis } | { status: "superseded" };

export type InitProgress = (loaded: number, total: number | null) => void;

export class EngineInitError extends Error {
  override name = "EngineInitError";
}
export class WorkerDiedError extends Error {
  override name = "WorkerDiedError";
}
export class DisposedError extends Error {
  override name = "DisposedError";
}
export class AnalyzeTimeoutError extends Error {
  override name = "AnalyzeTimeoutError";
}
export class AnalyzeError extends Error {
  override name = "AnalyzeError";

  constructor(
    message: string,
    public readonly stage: PipelineStage,
  ) {
    super(message);
  }
}
export class LiveSessionError extends Error {
  override name = "LiveSessionError";
}

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
}

// One live-update pushed from the worker: the full current track
// list plus per-stage timings for the processed frame.
export interface LiveUpdate {
  frameId: FrameId;
  tracks: Track[];
  timings: Record<string, number>;
}

export interface WorkerClient {
  init(onProgress?: InitProgress): Promise<void>;
  analyze(frame: Frame, options?: DetectOptions): Promise<AnalyzeResult>;
  startLive(onUpdate: (update: LiveUpdate) => void): Promise<void>;
  // The caller's frame.pixels buffer is transferred (not copied) to
  // the worker: it is detached/neutered on return and must not be
  // read or reused afterward.
  sendLiveFrame(frame: Frame, captureMs: number, options?: DetectOptions): void;
  sendMark(mark: Mark): Promise<void>;
  stopLive(): Promise<void>;
  dispose(): void;
}

interface PendingAnalyze {
  resolve(result: AnalyzeResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingVoid {
  resolve(): void;
  reject(error: Error): void;
}

function defaultWasmUrl(): string {
  const base =
    (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return `${base}vendor/${OPENCV_VENDOR_FILE}`;
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL("../worker/vision.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

export function createWorkerClient(
  options: {
    createWorker?: () => WorkerLike;
    wasmUrl?: string;
    timeoutMs?: number;
  } = {},
): WorkerClient {
  const timeoutMs = options.timeoutMs ?? ANALYZE_TIMEOUT_MS;
  const wasmUrl = options.wasmUrl ?? defaultWasmUrl();
  const makeWorker = options.createWorker ?? defaultWorker;

  let worker: WorkerLike | null = null;
  let initPromise: Promise<void> | null = null;
  let initSettle: { resolve(): void; reject(error: Error): void } | null = null;
  const progressListeners: InitProgress[] = [];
  const pending = new Map<FrameId, PendingAnalyze>();
  let fatal: Error | null = null;
  let ready = false;
  let liveActive = false;
  let onLiveUpdate: ((update: LiveUpdate) => void) | null = null;
  let liveStartPending: PendingVoid | null = null;
  let liveStartPromise: Promise<void> | null = null;
  let liveStopPending: PendingVoid | null = null;
  let liveStopPromise: Promise<void> | null = null;
  const markPending = new Map<MarkId, PendingVoid>();
  let markCounter = 0;

  function failAll(error: Error): void {
    fatal = error;
    initSettle?.reject(error);
    initSettle = null;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    liveStartPending?.reject(error);
    liveStartPending = null;
    liveStartPromise = null;
    liveStopPending?.reject(error);
    liveStopPending = null;
    liveStopPromise = null;
    for (const [, entry] of markPending) entry.reject(error);
    markPending.clear();
    liveActive = false;
    onLiveUpdate = null;
  }

  function handleResponse(data: unknown): void {
    if (!isWorkerResponse(data)) return;
    switch (data.type) {
      case "init-progress":
        for (const listen of progressListeners) {
          listen(data.loaded, data.total);
        }
        return;
      case "ready":
        ready = true;
        initSettle?.resolve();
        initSettle = null;
        return;
      case "init-error":
        failAll(new EngineInitError(data.message));
        return;
      case "result":
      case "dropped":
      case "analyze-error": {
        const entry = pending.get(data.frameId);
        // no entry: a late reply after timeout/failure, or a live
        // frame superseded in the worker's mailbox (benign)
        if (!entry) return;
        pending.delete(data.frameId);
        clearTimeout(entry.timer);
        if (data.type === "result") {
          entry.resolve({ status: "ok", analysis: data.analysis });
        } else if (data.type === "dropped") {
          entry.resolve({ status: "superseded" });
        } else {
          entry.reject(new AnalyzeError(data.message, data.stage));
        }
        return;
      }
      case "live-ready":
        liveStartPending?.resolve();
        liveStartPending = null;
        return;
      case "live-update":
        onLiveUpdate?.({
          frameId: data.frameId,
          tracks: data.tracks,
          timings: data.timings,
        });
        return;
      case "mark-ack": {
        const entry = markPending.get(data.markId);
        if (!entry) return;
        markPending.delete(data.markId);
        entry.resolve();
        return;
      }
      case "live-stopped":
        liveStopPending?.resolve();
        liveStopPending = null;
        return;
    }
  }

  function post<K extends RequestKind>(
    request: RequestOf<K>,
    transfer?: Transferable[],
  ): void {
    worker?.postMessage(request, transfer);
  }

  function init(onProgress?: InitProgress): Promise<void> {
    if (onProgress && !progressListeners.includes(onProgress)) {
      progressListeners.push(onProgress);
    }
    if (fatal) return Promise.reject(fatal);
    if (initPromise) return initPromise;
    worker = makeWorker();
    worker.onmessage = (event) => handleResponse(event.data);
    worker.onerror = () => failAll(new WorkerDiedError("worker error"));
    worker.onmessageerror = () =>
      failAll(new WorkerDiedError("message deserialization failed"));
    initPromise = new Promise<void>((resolve, reject) => {
      initSettle = { resolve, reject };
    });
    post<"init">({ type: "init", wasmUrl });
    return initPromise;
  }

  function analyze(
    frame: Frame,
    options?: DetectOptions,
  ): Promise<AnalyzeResult> {
    if (liveActive) {
      return Promise.reject(new LiveSessionError("stop live before analyze"));
    }
    return new Promise<AnalyzeResult>((resolve, reject) => {
      // Registers the pending entry and posts the message. Must run
      // synchronously (not via async/await) when already ready, so a
      // caller who awaited init() can synchronously observe the
      // posted message and reply to it in the same tick (pinned by
      // the test suite's fake-worker `emit` calls).
      const send = () => {
        if (fatal) {
          reject(fatal);
          return;
        }
        const timer = setTimeout(() => {
          // a silent worker is a dead worker: fail everything
          failAll(new AnalyzeTimeoutError(`no reply in ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(frame.id, { resolve, reject, timer });
        // transfer a COPY: transferring frame.pixels itself would
        // detach the caller's buffer and break re-analyze. The slice
        // is transferred (zero-copy at the message boundary); the
        // source frame stays whole.
        const payload = { ...frame, pixels: frame.pixels.slice(0) };
        post<"analyze">({ type: "analyze", frame: payload, options }, [
          payload.pixels,
        ]);
      };
      if (ready) {
        send();
      } else {
        init().then(send, reject);
      }
    });
  }

  function startLive(onUpdate: (update: LiveUpdate) => void): Promise<void> {
    if (pending.size > 0) {
      return Promise.reject(
        new LiveSessionError("analyze pending; wait before going live"),
      );
    }
    if (liveActive) {
      return Promise.reject(new LiveSessionError("live already active"));
    }
    // Registered synchronously (before any await on init()), so a
    // second concurrent pre-ready call sees it and shares this same
    // promise instead of overwriting liveStartPending and orphaning
    // the first caller.
    if (liveStartPromise) return liveStartPromise;
    liveStartPromise = new Promise<void>((resolve, reject) => {
      const settle = {
        resolve: () => {
          liveActive = true;
          onLiveUpdate = onUpdate;
          liveStartPromise = null;
          resolve();
        },
        reject: (error: Error) => {
          liveStartPromise = null;
          reject(error);
        },
      };
      const send = () => {
        if (fatal) {
          settle.reject(fatal);
          return;
        }
        liveStartPending = settle;
        post<"live-start">({ type: "live-start" });
      };
      if (ready) {
        send();
      } else {
        init().then(send, settle.reject);
      }
    });
    return liveStartPromise;
  }

  function sendLiveFrame(
    frame: Frame,
    captureMs: number,
    options?: DetectOptions,
  ): void {
    if (!liveActive || fatal) return;
    // transfer the caller's buffer DIRECTLY: live frames are minted
    // fresh per capture and never re-analyzed, so — unlike analyze(),
    // which transfers a copy to keep the source frame usable for
    // re-analyze — there is nothing to preserve and no reason to pay
    // for a copy at live rates.
    post<"live-frame">({ type: "live-frame", frame, captureMs, options }, [
      frame.pixels,
    ]);
  }

  function sendMark(mark: Mark): Promise<void> {
    if (fatal) return Promise.reject(fatal);
    if (!liveActive) {
      return Promise.reject(new LiveSessionError("live not active"));
    }
    return new Promise<void>((resolve, reject) => {
      const id = markId(++markCounter);
      markPending.set(id, { resolve, reject });
      post<"live-feedback">({ type: "live-feedback", markId: id, mark });
    });
  }

  function stopLive(): Promise<void> {
    if (!liveActive) return Promise.resolve();
    if (fatal) return Promise.reject(fatal);
    // liveActive stays true until live-stopped arrives, so a second
    // concurrent call lands here too; share the in-flight promise
    // instead of overwriting liveStopPending and orphaning the first
    // caller (and posting live-stop twice).
    if (liveStopPromise) return liveStopPromise;
    liveStopPromise = new Promise<void>((resolve, reject) => {
      liveStopPending = {
        resolve: () => {
          liveActive = false;
          onLiveUpdate = null;
          liveStopPromise = null;
          resolve();
        },
        reject: (error: Error) => {
          liveStopPromise = null;
          reject(error);
        },
      };
      post<"live-stop">({ type: "live-stop" });
    });
    return liveStopPromise;
  }

  function dispose(): void {
    failAll(new DisposedError("client disposed"));
    worker?.terminate();
    worker = null;
    initPromise = null;
  }

  return {
    init,
    analyze,
    startLive,
    sendLiveFrame,
    sendMark,
    stopLive,
    dispose,
  };
}
