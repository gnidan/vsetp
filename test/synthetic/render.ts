import sharp from "sharp";
import type { Card, Color, Fill, Quad, Shape } from "../../src/model";
import { CARD_RASTER } from "../../src/vision/adapter";

const INK: Record<Color, string> = {
  red: "#d43a2f",
  green: "#3fa652",
  purple: "#6a2c91",
};

// symbol box; short axis 120 => stripe spacing 14 ~= 8 stripe pairs
const SYMBOL = { width: 120, height: 240 };

function symbolShape(shape: Shape): string {
  const { width: w, height: h } = SYMBOL;
  switch (shape) {
    case "diamond":
      return `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`;
    case "oval":
      return (
        `M ${w / 2} 0 A ${w / 2} ${w / 2} 0 0 1 ${w} ${w / 2} ` +
        `L ${w} ${h - w / 2} A ${w / 2} ${w / 2} 0 0 1 ${w / 2} ${h} ` +
        `A ${w / 2} ${w / 2} 0 0 1 0 ${h - w / 2} L 0 ${w / 2} ` +
        `A ${w / 2} ${w / 2} 0 0 1 ${w / 2} 0 Z`
      );
    case "squiggle":
      // smooth pinched (non-convex) stand-in: what the shape
      // classifier keys on is convexity defects vs. smooth ovals
      return (
        `M 60 10 C 105 10 120 55 100 85 C 88 103 88 137 100 155 ` +
        `C 120 185 105 230 60 230 C 15 230 0 185 20 155 ` +
        `C 32 137 32 103 20 85 C 0 55 15 10 60 10 Z`
      );
  }
}

function fillAttrs(fill: Fill, color: Color, patternId: string): string {
  const ink = INK[color];
  switch (fill) {
    case "solid":
      return `fill="${ink}" stroke="${ink}" stroke-width="4"`;
    case "open":
      return `fill="#ffffff" stroke="${ink}" stroke-width="6"`;
    case "striped":
      return `fill="url(#${patternId})" stroke="${ink}" stroke-width="5"`;
  }
}

function stripePattern(patternId: string, color: Color): string {
  return (
    `<pattern id="${patternId}" width="14" height="14" ` +
    `patternUnits="userSpaceOnUse">` +
    `<rect width="14" height="14" fill="#ffffff"/>` +
    `<line x1="4" y1="0" x2="4" y2="14" stroke="${INK[color]}" ` +
    `stroke-width="5"/></pattern>`
  );
}

// SVG for one card face of the given pixel height (white rounded rect
// plus a centered row of `count` symbols), origin at (0, 0). Width
// follows from the CARD_RASTER aspect ratio by construction.
function cardFaceSvg(card: Card, height: number): string {
  const patternId = `stripe-${card.color}`;
  const scale = height / (CARD_RASTER.height as number);
  const gap = 24;
  const rowWidth = card.count * SYMBOL.width + (card.count - 1) * gap;
  const symbols: string[] = [];
  for (let i = 0; i < card.count; i++) {
    const x = (CARD_RASTER.width - rowWidth) / 2 + i * (SYMBOL.width + gap);
    const y = (CARD_RASTER.height - SYMBOL.height) / 2;
    symbols.push(
      `<path transform="translate(${x} ${y})" ` +
        `d="${symbolShape(card.shape)}" ` +
        `${fillAttrs(card.fill, card.color, patternId)}/>`,
    );
  }
  return (
    `<g transform="scale(${scale})">` +
    `<defs>${stripePattern(patternId, card.color)}</defs>` +
    `<rect width="${CARD_RASTER.width}" height="${CARD_RASTER.height}" ` +
    `rx="18" fill="#fdfdf8"/>` +
    symbols.join("") +
    `</g>`
  );
}

async function rasterize(svg: string): Promise<ImageData> {
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

export async function renderCardRaster(card: Card): Promise<ImageData> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${CARD_RASTER.width}" height="${CARD_RASTER.height}">` +
    cardFaceSvg(card, CARD_RASTER.height) +
    `</svg>`;
  return rasterize(svg);
}

export interface TruthCard {
  card: Card;
  quad: Quad;
}

export interface TableauRender {
  image: ImageData;
  truth: TruthCard[];
}

export interface TableauOptions {
  width?: number;
  height?: number;
  background?: string;
  rotate?: boolean;
  blanks?: number;
}

// A card-shaped face with no symbols: stands in for a face-down card,
// a blank card, or a box lid — anything the detector might find that
// has no readable symbols. Deliberately excluded from `truth`:
// analyze() must not surface it as a detected card.
function blankFaceSvg(height: number): string {
  const scale = height / (CARD_RASTER.height as number);
  return (
    `<g transform="scale(${scale})">` +
    `<rect width="${CARD_RASTER.width}" height="${CARD_RASTER.height}" ` +
    `rx="18" fill="#fdfdf8"/>` +
    `</g>`
  );
}

function rotatedQuad(
  x: number,
  y: number,
  w: number,
  h: number,
  degrees: number,
): Quad {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rad = (degrees * Math.PI) / 180;
  const rot = (px: number, py: number) => ({
    x: cx + (px - cx) * Math.cos(rad) - (py - cy) * Math.sin(rad),
    y: cy + (px - cx) * Math.sin(rad) + (py - cy) * Math.cos(rad),
  });
  return [rot(x, y), rot(x + w, y), rot(x + w, y + h), rot(x, y + h)] as Quad;
}

export async function renderTableau(
  cards: Card[],
  options: TableauOptions = {},
): Promise<TableauRender> {
  const width = options.width ?? 1600;
  const height = options.height ?? 1200;
  const background = options.background ?? "#2e6b4f";
  const rotate = options.rotate ?? true;
  const blanks = options.blanks ?? 0;
  const cardH = 192;
  const cardW = cardH * (CARD_RASTER.width / CARD_RASTER.height);
  const columns = 4;
  const total = cards.length + blanks;
  const gapX = (width - columns * cardW) / (columns + 1);
  const rows = Math.ceil(total / columns);
  const gapY = (height - rows * cardH) / (rows + 1);

  // shared grid placement so blanks slot into the same layout as the
  // real cards, just later in reading order
  const placeAt = (i: number) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = gapX + col * (cardW + gapX);
    const y = gapY + row * (cardH + gapY);
    // deterministic pseudo-random rotation, +-6 degrees
    const degrees = rotate ? ((i * 37) % 13) - 6 : 0;
    return { x, y, degrees };
  };

  const pieces: string[] = [];
  const truth: TruthCard[] = [];
  cards.forEach((card, i) => {
    const { x, y, degrees } = placeAt(i);
    pieces.push(
      `<g transform="translate(${x} ${y}) ` +
        `rotate(${degrees} ${cardW / 2} ${cardH / 2})">` +
        cardFaceSvg(card, cardH) +
        `</g>`,
    );
    truth.push({ card, quad: rotatedQuad(x, y, cardW, cardH, degrees) });
  });

  // blank distractor faces, appended after the real cards and placed
  // in the same grid; NOT added to `truth` (see blankFaceSvg)
  for (let j = 0; j < blanks; j++) {
    const { x, y, degrees } = placeAt(cards.length + j);
    pieces.push(
      `<g transform="translate(${x} ${y}) ` +
        `rotate(${degrees} ${cardW / 2} ${cardH / 2})">` +
        blankFaceSvg(cardH) +
        `</g>`,
    );
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="${background}"/>` +
    pieces.join("") +
    `</svg>`;
  return { image: await rasterize(svg), truth };
}
