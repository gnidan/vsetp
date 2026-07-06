import sharp from "sharp";
import type { Card, Quad } from "../../src/model";
import { cardFaceSvg } from "../../src/ui/card-face";
import { CARD_RASTER } from "../../src/vision/adapter";

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
