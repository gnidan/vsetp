import type { Frame, FrameId } from "../model";
import type { DetectOptions } from "../vision/adapter";

export interface Pending {
  frame: Frame;
  options?: DetectOptions;
}

// Depth-1 newest-wins mailbox: at most one waiting frame; a newer
// arrival displaces it (the displaced frame is answered "dropped").
export interface Mailbox {
  waiting: Pending | null;
  pumping: boolean;
}

export function createMailbox(): Mailbox {
  return { waiting: null, pumping: false };
}

export function accept(box: Mailbox, incoming: Pending): FrameId | null {
  const dropped = box.waiting ? box.waiting.frame.id : null;
  box.waiting = incoming;
  return dropped;
}

export function next(box: Mailbox): Pending | null {
  const pending = box.waiting;
  box.waiting = null;
  return pending;
}
