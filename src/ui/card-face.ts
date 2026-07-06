import type { Card, Color, Fill, Shape } from "../model";
import { CARD_RASTER } from "../vision/adapter";

export const INK: Record<Color, string> = {
  red: "#d43a2f",
  green: "#3fa652",
  purple: "#6a2c91",
};

// symbol box + row gap, matched to real cards (measured on
// pic1326145's rectified faces: symbol boxes ~126-136 x 245-269,
// symbol centroid pitch ~157-176) so ghost overlays trace the real
// ink; short axis 128 => stripe spacing 14 ~= 9 stripe pairs
export const SYMBOL = { width: 128, height: 260 };
const SYMBOL_GAP = 32; // centroid pitch 160

export function symbolShape(shape: Shape): string {
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
    case "squiggle": {
      // tilde-like S-wave running along the box's long axis, matching
      // the real Set glyph (measured on pic1326145's rectified
      // squiggles: solidity ~0.85, defect ratio ~0.17, bbox fill
      // ~0.73-0.77): a thick stroke whose centerline swings right
      // then left going down the box — the real glyph's chirality,
      // verified by alpha-blending this raster over a real rectified
      // squiggle card (the mirrored variant interleaves with the ink
      // instead of tracing it) — leaving one deep concavity on each
      // side. 180-degree rotationally symmetric; smooth, unbroken,
      // non-convex.
      const cx = w / 2;
      const t = 0.35 * w; // half stroke thickness
      const a = 0.125 * w; // wave amplitude (centerline swing)
      const b = (4 / 3) * a; // cubic ctrl offset: curve peaks at a
      const top = 0.14 * h;
      const bottom = h - top;
      const mid = h / 2;
      const cap = t; // end-cap ctrl offset (depth 0.75*cap)
      const y1 = top + (mid - top) / 3;
      const y2 = top + (2 * (mid - top)) / 3;
      const y3 = mid + (bottom - mid) / 3;
      const y4 = mid + (2 * (bottom - mid)) / 3;
      const r = cx + t; // right edge at centerline crossings
      const l = cx - t; // left edge at centerline crossings
      return (
        `M ${r} ${top} ` +
        `C ${r + b} ${y1} ${r + b} ${y2} ${r} ${mid} ` +
        `C ${r - b} ${y3} ${r - b} ${y4} ${r} ${bottom} ` +
        `C ${r} ${bottom + cap} ${l} ${bottom + cap} ${l} ${bottom} ` +
        `C ${l - b} ${y4} ${l - b} ${y3} ${l} ${mid} ` +
        `C ${l + b} ${y2} ${l + b} ${y1} ${l} ${top} ` +
        `C ${l} ${top - cap} ${r} ${top - cap} ${r} ${top} Z`
      );
    }
  }
}

export function fillAttrs(fill: Fill, color: Color, patternId: string): string {
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

export function stripePattern(patternId: string, color: Color): string {
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
export function cardFaceSvg(card: Card, height: number): string {
  const patternId = `stripe-${card.color}`;
  const scale = height / (CARD_RASTER.height as number);
  const gap = SYMBOL_GAP;
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

export function cardFaceDataUrl(card: Card): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${CARD_RASTER.width}" height="${CARD_RASTER.height}">` +
    cardFaceSvg(card, CARD_RASTER.height) +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Ghost variant: no white face rect (the real card shows through), the
// symbols nested inside the real ink by shrinking about their own
// centers, plus a cyan halo ring around each symbol (matching the
// detection outline color) that stands in for the "this is a ghost"
// cue the removed white wash used to carry.
export const GHOST_SYMBOL_SCALE = 0.8;
export const GHOST_SYMBOL_OUTLINE = "#00e5ff";

// Ghost open fill is fully transparent (the real card shows through
// the symbol interior); the shared fillAttrs' opaque white doesn't
// apply here. Solid/striped ink rendering is unchanged.
function ghostFillAttrs(fill: Fill, color: Color, patternId: string): string {
  if (fill === "open") {
    const ink = INK[color];
    return `fill="none" stroke="${ink}" stroke-width="6"`;
  }
  return fillAttrs(fill, color, patternId);
}

// Ghost stripe pattern: same spacing/stroke as the real face's, but
// rotated 90 degrees (the ghost's stripes otherwise ran perpendicular
// to the real printed ones) and with no white background rect, so the
// gaps between stripes stay transparent like the rest of the ghost.
function ghostStripePattern(patternId: string, color: Color): string {
  return (
    `<pattern id="${patternId}" width="14" height="14" ` +
    `patternUnits="userSpaceOnUse" patternTransform="rotate(90)">` +
    `<line x1="4" y1="0" x2="4" y2="14" stroke="${INK[color]}" ` +
    `stroke-width="5"/></pattern>`
  );
}

// SVG for one ghost card face at CARD_RASTER size, origin at (0, 0),
// no background rect (fully transparent). Reuses cardFaceSvg's row
// layout math so nested symbols line up with the real printed ones.
export function ghostFaceSvg(card: Card): string {
  const patternId = `ghost-stripe-${card.color}`;
  const gap = SYMBOL_GAP;
  const { width: w, height: h } = SYMBOL;
  const rowWidth = card.count * w + (card.count - 1) * gap;
  const symbols: string[] = [];
  for (let i = 0; i < card.count; i++) {
    const x = (CARD_RASTER.width - rowWidth) / 2 + i * (w + gap);
    const y = (CARD_RASTER.height - h) / 2;
    const transform =
      `translate(${x} ${y}) translate(${w / 2} ${h / 2}) ` +
      `scale(${GHOST_SYMBOL_SCALE}) translate(${-w / 2} ${-h / 2})`;
    const d = symbolShape(card.shape);
    symbols.push(
      `<path transform="${transform}" d="${d}" fill="none" ` +
        `stroke="${GHOST_SYMBOL_OUTLINE}" stroke-width="14" ` +
        `stroke-linejoin="round"/>`,
      `<path transform="${transform}" d="${d}" ` +
        `${ghostFillAttrs(card.fill, card.color, patternId)}/>`,
    );
  }
  return (
    `<defs>${ghostStripePattern(patternId, card.color)}</defs>` +
    symbols.join("")
  );
}

export function ghostFaceDataUrl(card: Card): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${CARD_RASTER.width}" height="${CARD_RASTER.height}">` +
    ghostFaceSvg(card) +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
