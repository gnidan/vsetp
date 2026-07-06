import sharp from "sharp";
import type { CardKey, Frame, Point } from "../../src/model";
import { cardFromKey, frameId } from "../../src/model";
import { cardFaceSvg } from "../../src/ui/card-face";
import { CARD_RASTER } from "../../src/vision/adapter";

// Live capture long edge (spec: live engine). No exported constant
// owns this yet — the client capture path that will is Plan D2; keep
// this literal in sync when it lands.
export const LIVE_FRAME_MAX_DIMENSION = 768;

// Synthetic table space: 4:3, twice the live frame in each dimension,
// so a scale-1 window downsamples 2x into a 768x576 frame.
export const TABLE = { width: 1536, height: 1152 } as const;

// Card height in table space. 288 puts a card at 144px tall in a
// scale-1 live frame — above the ~123px detection height the
// still-pipeline synthetic tests exercise (1600px tableau, 192px
// cards, detected at maxDimension 1024), and tall enough that the
// rectified read is solid: the fill classifier's unresolved-stripe
// branch covers stripes that blur below raster resolution.
export const SEQUENCE_CARD_HEIGHT = 288;

export const SEQUENCE_CARD_WIDTH =
  SEQUENCE_CARD_HEIGHT * (CARD_RASTER.width / CARD_RASTER.height);

const FELT = "#2e6b4f";
const FELT_RGB = { r: 0x2e, g: 0x6b, b: 0x4f, alpha: 1 } as const;

export interface SequenceStep {
  scale: number;
  dx: number;
  dy: number;
}

export interface SequenceSpec {
  // table positions (px, on a TABLE.width x TABLE.height synthetic
  // table); `at` is the CENTER of the card face
  cards: { key: CardKey; at: Point }[];
  // camera path: each step renders the window (table * scale, offset
  // dx,dy) downscaled to LIVE_FRAME_MAX_DIMENSION long edge
  steps: SequenceStep[];
}

function frameSize(
  winW: number,
  winH: number,
): {
  width: number;
  height: number;
} {
  const factor = LIVE_FRAME_MAX_DIMENSION / Math.max(winW, winH);
  return {
    width: Math.round(winW * factor),
    height: Math.round(winH * factor),
  };
}

// Maps a table-space point to frame coordinates under a step — the
// tests use this to pair tracked centroids with placed card faces.
export function projectToFrame(step: SequenceStep, at: Point): Point {
  const winW = TABLE.width * step.scale;
  const winH = TABLE.height * step.scale;
  const out = frameSize(winW, winH);
  return {
    x: ((at.x - step.dx) * out.width) / winW,
    y: ((at.y - step.dy) * out.height) / winH,
  };
}

// The full synthetic table, rendered once as raw RGBA: felt
// background plus card-face rasters (same SVG machinery render.ts
// uses for the still-pipeline tableaux).
async function renderTable(cards: SequenceSpec["cards"]): Promise<Buffer> {
  const pieces = cards.map(({ key, at }) => {
    const x = at.x - SEQUENCE_CARD_WIDTH / 2;
    const y = at.y - SEQUENCE_CARD_HEIGHT / 2;
    return (
      `<g transform="translate(${x} ${y})">` +
      cardFaceSvg(cardFromKey(key), SEQUENCE_CARD_HEIGHT) +
      `</g>`
    );
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${TABLE.width}" height="${TABLE.height}">` +
    `<rect width="${TABLE.width}" height="${TABLE.height}" ` +
    `fill="${FELT}"/>` +
    pieces.join("") +
    `</svg>`;
  return sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
}

// Renders a scripted camera path over the synthetic table: the table
// rasterizes once, then each step extracts its window and downscales
// it to the live working size. Windows may leave the table (pans,
// drift at the edge); the world beyond the table is more felt, so the
// raster is extended once to cover every step's window.
export async function renderSequence(spec: SequenceSpec): Promise<Frame[]> {
  const table = await renderTable(spec.cards);

  let left = 0;
  let top = 0;
  let right: number = TABLE.width;
  let bottom: number = TABLE.height;
  for (const step of spec.steps) {
    left = Math.min(left, Math.round(step.dx));
    top = Math.min(top, Math.round(step.dy));
    right = Math.max(
      right,
      Math.round(step.dx) + Math.round(TABLE.width * step.scale),
    );
    bottom = Math.max(
      bottom,
      Math.round(step.dy) + Math.round(TABLE.height * step.scale),
    );
  }
  const extended = await sharp(table, {
    raw: { width: TABLE.width, height: TABLE.height, channels: 4 },
  })
    .extend({
      left: -left,
      top: -top,
      right: right - TABLE.width,
      bottom: bottom - TABLE.height,
      background: FELT_RGB,
    })
    .raw()
    .toBuffer();
  const extendedWidth = right - left;
  const extendedHeight = bottom - top;

  const frames: Frame[] = [];
  for (const [i, step] of spec.steps.entries()) {
    const winW = Math.round(TABLE.width * step.scale);
    const winH = Math.round(TABLE.height * step.scale);
    const out = frameSize(winW, winH);
    const pixels = await sharp(extended, {
      raw: { width: extendedWidth, height: extendedHeight, channels: 4 },
    })
      .extract({
        left: Math.round(step.dx) - left,
        top: Math.round(step.dy) - top,
        width: winW,
        height: winH,
      })
      .resize(out.width, out.height, { fit: "fill" })
      .raw()
      .toBuffer();
    frames.push({
      id: frameId(i + 1), // ids only need uniqueness within a test
      width: out.width,
      height: out.height,
      // copy out of sharp's Buffer into a standalone ArrayBuffer
      pixels: new Uint8Array(pixels).buffer,
    });
  }
  return frames;
}
