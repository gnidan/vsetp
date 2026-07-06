import type { Frame, FrameAnalysis, FrameId } from "../model";
import type { DetectOptions } from "../vision/adapter";
import { OPENCV_VENDOR_FILE } from "../vision/opencv/cv";
import type { PipelineStage, RequestOf } from "../worker/protocol";
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

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
}

export interface WorkerClient {
  init(onProgress?: InitProgress): Promise<void>;
  analyze(frame: Frame, options?: DetectOptions): Promise<AnalyzeResult>;
  dispose(): void;
}

interface PendingAnalyze {
  resolve(result: AnalyzeResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
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

  function failAll(error: Error): void {
    fatal = error;
    initSettle?.reject(error);
    initSettle = null;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
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
        if (!entry) return; // late reply after timeout/failure
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
    }
  }

  function post<K extends "init" | "analyze">(
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

  function dispose(): void {
    failAll(new DisposedError("client disposed"));
    worker?.terminate();
    worker = null;
    initPromise = null;
  }

  return { init, analyze, dispose };
}
