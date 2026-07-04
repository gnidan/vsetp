import { beforeAll, describe, expect, test } from "vitest";
import { renderTableau } from "../../../test/synthetic/render";
import type { Point, Quad } from "../../model";
import { allCards, cardKey } from "../../model";
import { findSets, makeTableau } from "../../set";
import type { CardVision } from "../adapter";
import { createCardVision } from "../opencv";
import { loadOpenCv } from "../opencv/load-node";
import { analyze } from "./analyze";

let vision: CardVision;
beforeAll(async () => {
  vision = createCardVision(await loadOpenCv());
}, 30_000);

function centroid(quad: Quad): Point {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}

describe("analyze end-to-end (synthetic)", () => {
  test("reads a 12-card tableau correctly and finds its sets", async () => {
    const dealt = allCards().slice(24, 36); // arbitrary varied slice
    const { image, truth } = await renderTableau(dealt);

    const { cards, timings } = analyze(vision, image);
    expect(cards).toHaveLength(12);

    // match each detection to the nearest truth card by centroid
    for (const detected of cards) {
      const c = centroid(detected.quad);
      const nearest = truth.reduce((a, b) => {
        const da = Math.hypot(
          centroid(a.quad).x - c.x,
          centroid(a.quad).y - c.y,
        );
        const db = Math.hypot(
          centroid(b.quad).x - c.x,
          centroid(b.quad).y - c.y,
        );
        return da <= db ? a : b;
      });
      expect(cardKey(detected.card)).toBe(cardKey(nearest.card));
      for (const value of Object.values(detected.confidence)) {
        expect(value).toBeGreaterThan(0.2);
      }
    }

    // ids are sequential and unique
    expect(new Set(cards.map((c) => c.id)).size).toBe(12);

    // the solver over detections matches the solver over truth
    const detectedSets = findSets(
      makeTableau(cards.map(({ id, card }) => ({ id, card }))),
    );
    const truthSets = findSets(
      makeTableau(
        cards.map((detected) => {
          const c = centroid(detected.quad);
          const nearest = truth.reduce((a, b) =>
            Math.hypot(centroid(a.quad).x - c.x, centroid(a.quad).y - c.y) <=
            Math.hypot(centroid(b.quad).x - c.x, centroid(b.quad).y - c.y)
              ? a
              : b,
          );
          return { id: detected.id, card: nearest.card };
        }),
      ),
    );
    expect(detectedSets).toEqual(truthSets);

    // per-stage timings recorded (budget visibility from day one)
    for (const stage of ["detect", "rectify", "segment", "classify"]) {
      expect(timings[stage]).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);
});
