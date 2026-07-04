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
import type { DetectedCard, Point, Quad } from "../src/model";
import { cardKey } from "../src/model";
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

// heuristic label anchor: the quad corner closest to the image's
// top-left, regardless of the pipeline's angle-based corner order
function topLeft(quad: Quad): Point {
  return quad.reduce((a, b) => (a.x + a.y <= b.x + b.y ? a : b));
}

function svgOverlay(cards: DetectedCard[], width: number, height: number) {
  const fontSize = Math.max(16, Math.round(width / 80));
  const shapes = cards.map((c) => {
    const points = c.quad.map((p) => `${p.x},${p.y}`).join(" ");
    const label = `${c.id}: ${cardKey(c.card)}`;
    const anchor = topLeft(c.quad);
    const textY = Math.max(fontSize, anchor.y - 8);
    const textWidth = Math.round(label.length * fontSize * 0.62);
    return `
      <polygon points="${points}" fill="none" stroke="cyan"
        stroke-width="6" />
      <rect x="${anchor.x}" y="${textY - fontSize}"
        width="${textWidth}" height="${Math.round(fontSize * 1.3)}"
        fill="black" fill-opacity="0.65" />
      <text x="${anchor.x + 4}" y="${textY}" fill="cyan"
        font-size="${fontSize}" font-family="monospace">${label}</text>`;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${width}" height="${height}">${shapes.join("")}</svg>`
  );
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

  let cards: DetectedCard[];
  let timings: Record<string, number>;
  try {
    const vision = createCardVision(await loadOpenCv());
    const t0 = performance.now();
    ({ cards, timings } = analyze(vision, image));
    printTimings(timings, performance.now() - t0);
  } catch (err) {
    fail(`pipeline failed: ${(err as Error).message}`);
  }

  printCardTable(cards);

  const svg = svgOverlay(cards, image.width, image.height);
  await sharp(photo)
    .rotate()
    .composite([{ input: Buffer.from(svg) }])
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
