/// <reference lib="webworker" />
import type { FrameAnalysis } from "../model";
import { createCardVision } from "../vision/opencv";
import { loadOpenCvBrowser } from "../vision/opencv/load-browser";
import type { CardVision } from "../vision/adapter";
import { analyze } from "../vision/pipeline/analyze";
import { accept, createMailbox, next } from "./mailbox";
import type { Pending } from "./mailbox";
import type { PipelineStage, WorkerResponse } from "./protocol";
import { isWorkerRequest } from "./protocol";
import { withStageTracking } from "./stage-tracking";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const mailbox = createMailbox();
const stage = { current: "detect" as PipelineStage };
let vision: CardVision | null = null;

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
  // analyze
  const dropped = accept(mailbox, {
    frame: data.frame,
    options: data.options,
  });
  if (dropped !== null) post({ type: "dropped", frameId: dropped });
  schedulePump();
};
