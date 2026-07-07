import { describe, expect, test } from "vitest";
import type { Quad } from "../model";
import {
  EDGE_NO_FIRE_PX,
  HIT_PADDING_CLIENT_PX,
  MIN_HIT_CLIENT_PX,
  domToFrame,
  expandedHitBox,
  inNoFireZone,
} from "./stage-coords";

// Plain-object DOMRect stand-in: the functions only read the box
// fields, and node has no DOMRect constructor.
function rectOf(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  } as DOMRect;
}

const FRAME = { width: 768, height: 576 };

describe("domToFrame", () => {
  test("identity when the stage matches the frame exactly", () => {
    const rect = rectOf(0, 0, 768, 576);
    expect(domToFrame({ x: 384, y: 288 }, rect, FRAME)).toEqual({
      x: 384,
      y: 288,
    });
    expect(domToFrame({ x: 100, y: 50 }, rect, FRAME)).toEqual({
      x: 100,
      y: 50,
    });
  });

  test("inverts the horizontal-crop branch (portrait stage)", () => {
    // scale = 600/576 = 25/24; frame maps to 800x600, cropped to
    // 400 wide with offsetX = -200
    const rect = rectOf(0, 0, 400, 600);
    const center = domToFrame({ x: 200, y: 300 }, rect, FRAME);
    expect(center.x).toBeCloseTo(384);
    expect(center.y).toBeCloseTo(288);
    // the stage's left edge sits 200 client px into the frame
    const leftEdge = domToFrame({ x: 0, y: 300 }, rect, FRAME);
    expect(leftEdge.x).toBeCloseTo(192);
  });

  test("inverts the vertical-crop branch (squat stage)", () => {
    // scale = 800/768 = 25/24; frame maps to 800x600, cropped to
    // 300 tall with offsetY = -150
    const rect = rectOf(0, 0, 800, 300);
    const center = domToFrame({ x: 400, y: 150 }, rect, FRAME);
    expect(center.x).toBeCloseTo(384);
    expect(center.y).toBeCloseTo(288);
    const topEdge = domToFrame({ x: 400, y: 0 }, rect, FRAME);
    expect(topEdge.y).toBeCloseTo(144);
  });

  test("subtracts the stage's own client offset", () => {
    const rect = rectOf(10, 20, 768, 576);
    expect(domToFrame({ x: 394, y: 308 }, rect, FRAME)).toEqual({
      x: 384,
      y: 288,
    });
  });

  test("clamps to frame bounds at the corners", () => {
    const rect = rectOf(0, 0, 768, 576);
    expect(domToFrame({ x: -5, y: 600 }, rect, FRAME)).toEqual({
      x: 0,
      y: 576,
    });
    expect(domToFrame({ x: 800, y: -3 }, rect, FRAME)).toEqual({
      x: 768,
      y: 0,
    });
  });
});

describe("inNoFireZone", () => {
  const rect = rectOf(0, 0, 400, 600);

  test("fires near every edge", () => {
    expect(inNoFireZone({ x: 10, y: 300 }, rect)).toBe(true); // left
    expect(inNoFireZone({ x: 390, y: 300 }, rect)).toBe(true); // right
    expect(inNoFireZone({ x: 200, y: 10 }, rect)).toBe(true); // top
    expect(inNoFireZone({ x: 200, y: 590 }, rect)).toBe(true); // bottom
  });

  test("the interior is clear, boundary exclusive", () => {
    expect(inNoFireZone({ x: 200, y: 300 }, rect)).toBe(false);
    expect(inNoFireZone({ x: EDGE_NO_FIRE_PX, y: 300 }, rect)).toBe(false);
    expect(inNoFireZone({ x: EDGE_NO_FIRE_PX - 0.5, y: 300 }, rect)).toBe(true);
  });

  test("honors the stage's client offset", () => {
    const offset = rectOf(100, 50, 400, 600);
    expect(inNoFireZone({ x: 110, y: 300 }, offset)).toBe(true);
    expect(inNoFireZone({ x: 200, y: 300 }, offset)).toBe(false);
  });
});

describe("expandedHitBox", () => {
  const bigQuad: Quad = [
    { x: 100, y: 100 },
    { x: 300, y: 100 },
    { x: 300, y: 200 },
    { x: 100, y: 200 },
  ];

  test("pads a large quad's bounding box", () => {
    // scale 1: pad = HIT_PADDING_CLIENT_PX frame px on each side
    expect(expandedHitBox(bigQuad, 1)).toEqual({
      left: 100 - HIT_PADDING_CLIENT_PX,
      top: 100 - HIT_PADDING_CLIENT_PX,
      width: 200 + 2 * HIT_PADDING_CLIENT_PX,
      height: 100 + 2 * HIT_PADDING_CLIENT_PX,
    });
  });

  test("grows a small quad to the 44pt client floor, centered", () => {
    const small: Quad = [
      { x: 100, y: 100 },
      { x: 120, y: 100 },
      { x: 120, y: 110 },
      { x: 100, y: 110 },
    ];
    const box = expandedHitBox(small, 1);
    expect(box.width).toBe(MIN_HIT_CLIENT_PX);
    expect(box.height).toBe(MIN_HIT_CLIENT_PX);
    expect(box.left + box.width / 2).toBeCloseTo(110); // centered
    expect(box.top + box.height / 2).toBeCloseTo(105);
  });

  test("the floor is in CLIENT px: frame-space size shrinks by scale", () => {
    const tiny: Quad = [
      { x: 100, y: 100 },
      { x: 104, y: 100 },
      { x: 104, y: 102 },
      { x: 100, y: 102 },
    ];
    const box = expandedHitBox(tiny, 2);
    expect(box.width).toBe(MIN_HIT_CLIENT_PX / 2);
    expect(box.height).toBe(MIN_HIT_CLIENT_PX / 2);
  });
});
