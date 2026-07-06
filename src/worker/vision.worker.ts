/// <reference lib="webworker" />
import type { FrameAnalysis } from "../model";
import { createCardVision } from "../vision/opencv";
import { loadOpenCvBrowser } from "../vision/opencv/load-browser";
import type { CardVision } from "../vision/adapter";
import { analyze } from "../vision/pipeline/analyze";
import {
  acceptFrame,
  acceptMark,
  clearLiveMailbox,
  createLiveMailbox,
  drainMarks,
  nextFrame,
} from "./live-mailbox";
import { createLiveSession, processLiveFrame } from "./live-session";
import type { LiveSession } from "./live-session";
import { accept, createMailbox, next } from "./mailbox";
import type { Pending } from "./mailbox";
import type { PipelineStage, WorkerResponse } from "./protocol";
import { isWorkerRequest } from "./protocol";
import { withStageTracking } from "./stage-tracking";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const mailbox = createMailbox();
const liveBox = createLiveMailbox();
const stage = { current: "detect" as PipelineStage };
let vision: CardVision | null = null;
let live: LiveSession | null = null;

function post(response: WorkerResponse): void {
  scope.postMessage(response);
}

function process(pending: Pending): void {
  const { frame, options } = pending;
  try {
    if (!vision) throw new Error("analyze before ready");
    stage.current = "detect";
    const image = new ImageData(
      new Uint8ClampedArray(frame.pixels),
      frame.width,
      frame.height,
    );
    const { cards, timings } = analyze(vision, image, options);
    const analysis: FrameAnalysis = {
      frameId: frame.id,
      frameSize: { width: frame.width, height: frame.height },
      cards,
      timings,
    };
    post({ type: "result", frameId: frame.id, analysis });
  } catch (error) {
    post({
      type: "analyze-error",
      frameId: frame.id,
      stage: stage.current,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function pump(): void {
  mailbox.pumping = false;
  const pending = next(mailbox);
  if (!pending) return;
  process(pending);
  schedulePump(); // drain anything accepted while processing
}

function schedulePump(): void {
  if (mailbox.pumping) return;
  mailbox.pumping = true;
  setTimeout(pump, 0); // macrotask: queued messages accept first
}

// Live pump: same macrotask-scheduled newest-wins shape as the
// analyze pump, over the live mailbox. Marks drain with the frame
// they precede.
function livePump(): void {
  liveBox.pumping = false;
  const pending = nextFrame(liveBox);
  if (!pending || !live) return;
  const marks = drainMarks(liveBox);
  try {
    if (!vision) throw new Error("live-frame before ready");
    const { tracks, timings } = processLiveFrame(
      vision,
      live,
      pending,
      marks,
      Date.now(),
    );
    post({
      type: "live-update",
      frameId: pending.frame.id,
      tracks,
      timings,
    });
  } catch (error) {
    // Live pipeline errors surface as analyze-error, same as the
    // analyze path, but no one is listening for it live: the client
    // only routes live-update/live-ready/live-stopped/mark-ack, so
    // this is client-invisible by design. The UI stall check in
    // Plan D2 is the user-facing signal for a wedged live session.
    post({
      type: "analyze-error",
      frameId: pending.frame.id,
      stage: stage.current,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  scheduleLivePump();
}

function scheduleLivePump(): void {
  if (liveBox.pumping) return;
  liveBox.pumping = true;
  setTimeout(livePump, 0); // macrotask: queued messages accept first
}

async function initialize(wasmUrl: string): Promise<void> {
  try {
    const cv = await loadOpenCvBrowser(wasmUrl, (loaded, total) =>
      post({ type: "init-progress", loaded, total }),
    );
    vision = withStageTracking(createCardVision(cv), stage);
    post({ type: "ready" });
  } catch (error) {
    post({
      type: "init-error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

scope.onmessage = (event: MessageEvent) => {
  const data: unknown = event.data;
  if (!isWorkerRequest(data)) return;
  if (data.type === "init") {
    void initialize(data.wasmUrl);
    return;
  }
  if (data.type === "live-start") {
    live = createLiveSession();
    post({ type: "live-ready" });
    return;
  }
  if (data.type === "live-frame") {
    if (live === null) {
      // benign: a frame in flight across a stop
      post({ type: "dropped", frameId: data.frame.id });
      return;
    }
    const displaced = acceptFrame(liveBox, {
      frame: data.frame,
      captureMs: data.captureMs,
      options: data.options,
    });
    if (displaced !== null) post({ type: "dropped", frameId: displaced });
    scheduleLivePump();
    return;
  }
  if (data.type === "live-feedback") {
    acceptMark(liveBox, { markId: data.markId, mark: data.mark });
    // ack = received; marks drain at the next processed frame
    post({ type: "mark-ack", markId: data.markId });
    return;
  }
  if (data.type === "live-stop") {
    live = null;
    clearLiveMailbox(liveBox);
    post({ type: "live-stopped" });
    return;
  }
  if (live !== null) {
    // worker-side handshake guard: analyze and live never interleave
    post({
      type: "analyze-error",
      frameId: data.frame.id,
      stage: "detect",
      message: "live session active",
    });
    return;
  }
  const dropped = accept(mailbox, {
    frame: data.frame,
    options: data.options,
  });
  if (dropped !== null) post({ type: "dropped", frameId: dropped });
  schedulePump();
};
