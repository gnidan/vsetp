import { describe, expect, test } from "vitest";
import { frameId } from "../model";
import type { Frame } from "../model";
import { accept, createMailbox, next } from "./mailbox";

function frameOf(id: number): Frame {
  return {
    id: frameId(id),
    width: 1,
    height: 1,
    pixels: new ArrayBuffer(4),
  };
}

describe("mailbox", () => {
  test("accepts into the empty slot without dropping", () => {
    const box = createMailbox();
    expect(accept(box, { frame: frameOf(1) })).toBeNull();
    expect(next(box)?.frame.id).toBe(1);
    expect(next(box)).toBeNull();
  });

  test("newest wins: displacing a waiting frame reports the drop", () => {
    const box = createMailbox();
    accept(box, { frame: frameOf(1) });
    expect(accept(box, { frame: frameOf(2) })).toBe(1);
    expect(accept(box, { frame: frameOf(3) })).toBe(2);
    expect(next(box)?.frame.id).toBe(3);
    expect(next(box)).toBeNull();
  });
});
