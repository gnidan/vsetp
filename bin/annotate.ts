#!/usr/bin/env -S npx tsx
// Dev tool: run the vision pipeline on a photo and write an annotated
// copy showing what it saw, plus a draft-labeling JSON stub. Not part
// of the formal plan — a script, not product code.
//
// Usage: npx tsx bin/annotate.ts <photo> [outPath]

import { writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import sharp from "sharp";
import "../test/setup"; // installs Node's ImageData shim (rectifyCard needs it)
import type { Card, DetectedCard, Point, Quad } from "../src/model";
import { cardKey } from "../src/model";
import { ghostFaceSvg } from "../src/ui/card-face";
import { CARD_RASTER } from "../src/vision/adapter";
import type { Cv } from "../src/vision/opencv/cv";
import { createCardVision } from "../src/vision/opencv";
import { loadOpenCv } from "../src/vision/opencv/load-node";
import { analyze } from "../src/vision/pipeline/analyze";

async function decodeImage(path: string): Promise<ImageData> {
  const { data, info } = await sharp(path)
    .rotate() // apply EXIF orientation
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(data),
    width: info.width,
    height: info.height,
    colorSpace: "srgb",
  } as ImageData;
}

function centroid(quad: Quad): Point {
  const x = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const y = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  return { x, y };
}

// spec: uncertain treatment is dashed (non-color), so a misread is
// still readable by color-blind users through line style alone
function isUncertain(c: DetectedCard): boolean {
  const { count, color, shape, fill } = c.confidence;
  return count < 0.5 || color < 0.5 || shape < 0.5 || fill < 0.5;
}

// thin quad outlines, dashed when any attribute confidence < 0.5;
// text labels are gone — the ghost layer carries the reading now
function svgOverlay(cards: DetectedCard[], width: number, height: number) {
  const shapes = cards.map((c) => {
    const points = c.quad.map((p) => `${p.x},${p.y}`).join(" ");
    const dash = isUncertain(c) ? ` stroke-dasharray="24,14"` : "";
    return (
      `<polygon points="${points}" fill="none" stroke="cyan" ` +
      `stroke-width="4"${dash} />`
    );
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${width}" height="${height}">${shapes.join("")}</svg>`
  );
}

// Ghost opacity is applied here, before warping: each raster's alpha
// channel is scaled to 90% up front, so warpPerspective's INTER_LINEAR
// resampling blends the reduced alpha smoothly at the warped card
// edges rather than uniformly dimming a hard-edged layer afterward.
const GHOST_OPACITY = 0.9;

function applyGhostAlpha(raster: ImageData): void {
  const { data } = raster;
  for (let i = 3; i < data.length; i += 4) {
    data[i] = Math.round(data[i] * GHOST_OPACITY);
  }
}

// Rasterizes the ghost SVG variant (transparent background, nested
// scaled-down symbols, dotted amber border) at CARD_RASTER size.
async function rasterizeGhost(card: Card): Promise<ImageData> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${CARD_RASTER.width}" height="${CARD_RASTER.height}">` +
    ghostFaceSvg(card) +
    `</svg>`;
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new ImageData(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
    info.width,
    info.height,
  );
}

// Warps one idealized card face onto `layer` at `quad`. `layer` may
// already hold previously-warped cards; cv.BORDER_TRANSPARENT leaves
// destination pixels outside this card's quad untouched, so calling
// this repeatedly with the same `layer` accumulates all cards onto
// one shared transparent overlay.
function warpGhostOnto(
  cv: Cv,
  layer: Cv,
  raster: ImageData,
  quad: Quad,
  width: number,
  height: number,
): void {
  let src: Cv = null;
  let srcCorners: Cv = null;
  let dstCorners: Cv = null;
  let transform: Cv = null;
  try {
    src = cv.matFromImageData(raster);
    // reverse mapping vs. rectifyCard: raster corners -> quad corners
    srcCorners = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0,
      0,
      CARD_RASTER.width,
      0,
      CARD_RASTER.width,
      CARD_RASTER.height,
      0,
      CARD_RASTER.height,
    ]);
    dstCorners = cv.matFromArray(4, 1, cv.CV_32FC2, [
      quad[0].x,
      quad[0].y,
      quad[1].x,
      quad[1].y,
      quad[2].x,
      quad[2].y,
      quad[3].x,
      quad[3].y,
    ]);
    transform = cv.getPerspectiveTransform(srcCorners, dstCorners);
    cv.warpPerspective(
      src,
      layer,
      transform,
      new cv.Size(width, height),
      cv.INTER_LINEAR,
      cv.BORDER_TRANSPARENT,
      new cv.Scalar(),
    );
  } finally {
    transform?.delete();
    dstCorners?.delete();
    srcCorners?.delete();
    src?.delete();
  }
}

// Idealized-card renderings, perspective-projected onto each
// detection's quad and composed into one transparent full-frame RGBA
// layer — misreads then show up as ghost-vs-photo mismatches.
async function buildGhostLayer(
  cv: Cv,
  cards: DetectedCard[],
  width: number,
  height: number,
): Promise<ImageData> {
  let layer: Cv = null;
  try {
    layer = cv.Mat.zeros(height, width, cv.CV_8UC4);
    for (const c of cards) {
      const raster = await rasterizeGhost(c.card);
      applyGhostAlpha(raster);
      warpGhostOnto(cv, layer, raster, c.quad, width, height);
    }
    return new ImageData(
      new Uint8ClampedArray(layer.data.slice()),
      width,
      height,
    );
  } finally {
    layer?.delete();
  }
}

function printTimings(timings: Record<string, number>, total: number) {
  const stages = Object.entries(timings)
    .map(([stage, ms]) => `${stage}=${ms.toFixed(2)}ms`)
    .join(" ");
  console.log(`timings: ${stages} total=${total.toFixed(2)}ms`);
}

function printCardTable(cards: DetectedCard[]) {
  const rows = cards.map((c) => {
    const { x, y } = centroid(c.quad);
    return {
      id: c.id,
      key: cardKey(c.card),
      count: c.confidence.count.toFixed(2),
      color: c.confidence.color.toFixed(2),
      shape: c.confidence.shape.toFixed(2),
      fill: c.confidence.fill.toFixed(2),
      x: Math.round(x),
      y: Math.round(y),
    };
  });
  console.table(rows);
}

function fail(message: string): never {
  console.error(`annotate: ${message}`);
  process.exit(1);
}

async function main() {
  const [, , photoArg, outArg] = process.argv;
  if (!photoArg) fail("usage: annotate.ts <photo> [outPath]");

  const photo = resolve(photoArg);
  const dir = dirname(photo);
  const stem = basename(photo, extname(photo));
  const outPath = outArg ? resolve(outArg) : join(dir, `${stem}-annotated.png`);
  const draftPath = join(dir, `${stem}-draft.json`);

  let image: ImageData;
  try {
    image = await decodeImage(photo);
  } catch (err) {
    fail(`failed to decode ${photo}: ${(err as Error).message}`);
  }

  let cv: Cv;
  let cards: DetectedCard[];
  let timings: Record<string, number>;
  try {
    cv = await loadOpenCv();
    const vision = createCardVision(cv);
    const t0 = performance.now();
    ({ cards, timings } = analyze(vision, image));
    printTimings(timings, performance.now() - t0);
  } catch (err) {
    fail(`pipeline failed: ${(err as Error).message}`);
  }

  printCardTable(cards);

  const ghost = await buildGhostLayer(cv, cards, image.width, image.height);
  const outline = svgOverlay(cards, image.width, image.height);
  await sharp(photo)
    .rotate()
    .composite([
      {
        input: Buffer.from(ghost.data),
        raw: { width: ghost.width, height: ghost.height, channels: 4 },
      },
      { input: Buffer.from(outline) },
    ])
    .toFile(outPath);
  console.log(`wrote ${outPath}`);

  const draft = {
    cards: cards.map((c) => {
      const { x, y } = centroid(c.quad);
      return {
        key: cardKey(c.card),
        near: { x: Math.round(x), y: Math.round(y) },
      };
    }),
  };
  writeFileSync(draftPath, JSON.stringify(draft, null, 2) + "\n");
  console.log(`wrote ${draftPath}`);
}

main();
