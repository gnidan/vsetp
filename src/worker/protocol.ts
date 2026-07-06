import type { Frame, FrameAnalysis, FrameId } from "../model";
import type { DetectOptions } from "../vision/adapter";

export type PipelineStage = "detect" | "rectify" | "segment" | "classify";

// THE protocol definition; everything else is derived from it.
// init-progress is a non-terminal response: it may arrive any number
// of times before ready/init-error settles the init request.
export interface WorkerProtocol {
  init: {
    request: { type: "init"; wasmUrl: string };
    response:
      | { type: "init-progress"; loaded: number; total: number | null }
      | { type: "ready" }
      | { type: "init-error"; message: string };
  };
  analyze: {
    request: { type: "analyze"; frame: Frame; options?: DetectOptions };
    response:
      | { type: "result"; frameId: FrameId; analysis: FrameAnalysis }
      | { type: "dropped"; frameId: FrameId }
      | {
          type: "analyze-error";
          frameId: FrameId;
          stage: PipelineStage;
          message: string;
        };
  };
}

export type RequestKind = keyof WorkerProtocol;
export type RequestOf<K extends RequestKind> = WorkerProtocol[K]["request"];
export type ResponseOf<K extends RequestKind> = WorkerProtocol[K]["response"];

export type WorkerRequest = RequestOf<RequestKind>;
export type WorkerResponse = ResponseOf<RequestKind>;

const REQUEST_TYPES = new Set<WorkerRequest["type"]>(["init", "analyze"]);
const RESPONSE_TYPES = new Set<WorkerResponse["type"]>([
  "init-progress",
  "ready",
  "init-error",
  "result",
  "dropped",
  "analyze-error",
]);

function discriminantOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const type = (data as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

// Thin discriminant guards: we control both ends and ship them in one
// build, so shape validation beyond the tag is dead weight (spec).
export function isWorkerRequest(data: unknown): data is WorkerRequest {
  const type = discriminantOf(data);
  return type !== null && REQUEST_TYPES.has(type as WorkerRequest["type"]);
}

export function isWorkerResponse(data: unknown): data is WorkerResponse {
  const type = discriminantOf(data);
  return type !== null && RESPONSE_TYPES.has(type as WorkerResponse["type"]);
}
