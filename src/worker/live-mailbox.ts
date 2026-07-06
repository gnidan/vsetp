import type { Frame, FrameId, Mark, MarkId } from "../model";
import type { DetectOptions } from "../vision/adapter";

export interface LivePending {
  frame: Frame;
  captureMs: number;
  options?: DetectOptions;
}

export interface MarkEntry {
  markId: MarkId;
  mark: Mark;
}

// Live variant of the depth-1 newest-wins mailbox: the frame slot
// drops stale frames, but marks queue separately and are NEVER
// dropped — displacing a frame must not discard user feedback
// (spec: live mailbox variant).
export interface LiveMailbox {
  waitingFrame: LivePending | null;
  marks: MarkEntry[];
  pumping: boolean;
}

export function createLiveMailbox(): LiveMailbox {
  return { waitingFrame: null, marks: [], pumping: false };
}

export function acceptFrame(
  box: LiveMailbox,
  incoming: LivePending,
): FrameId | null {
  const dropped = box.waitingFrame ? box.waitingFrame.frame.id : null;
  box.waitingFrame = incoming;
  return dropped;
}

export function acceptMark(box: LiveMailbox, entry: MarkEntry): void {
  box.marks.push(entry);
}

export function nextFrame(box: LiveMailbox): LivePending | null {
  const pending = box.waitingFrame;
  box.waitingFrame = null;
  return pending;
}

export function drainMarks(box: LiveMailbox): MarkEntry[] {
  return box.marks.splice(0);
}
