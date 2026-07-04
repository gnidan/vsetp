import { beforeAll, describe, expect, test } from "vitest";
import { renderTableau } from "../../../test/synthetic/render";
import { allCards } from "../../model";
import type { Point, Quad } from "../../model";
import type { Cv } from "./cv";
import { detectCards } from "./detect";
import { loadOpenCv } from "./load-node";

let cv: Cv;
beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000);

function centroid(quad: Quad): Point {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}

function nearestDistance(p: Point, points: Point[]): number {
  return Math.min(...points.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
}

describe("detectCards (primary)", () => {
  test("finds all 12 cards of a rotated tableau near truth", async () => {
    const { image, truth } = await renderTableau(allCards().slice(0, 12));
    const quads = detectCards(cv, image);
    expect(quads).toHaveLength(12);
    const truthCentroids = truth.map((t) => centroid(t.quad));
    for (const quad of quads) {
      expect(nearestDistance(centroid(quad), truthCentroids)).toBeLessThan(15);
    }
    // 1:1 mapping: each truth centroid matched by exactly one quad,
    // so a duplicate detection plus a miss cannot pass
    for (const t of truthCentroids) {
      const matches = quads.filter(
        (q) => Math.hypot(centroid(q).x - t.x, centroid(q).y - t.y) < 15,
      );
      expect(matches).toHaveLength(1);
    }
  });

  test("separates near-touching cards", async () => {
    // width chosen so inter-card gaps shrink to ~2px
    const { image } = await renderTableau(allCards().slice(0, 8), {
      width: 1210,
      height: 900,
      rotate: false,
    });
    expect(detectCards(cv, image)).toHaveLength(8);
  });

  test("returns [] for a frame with no cards", async () => {
    const { image } = await renderTableau([], {});
    expect(detectCards(cv, image)).toEqual([]);
  });
});

describe("detectCards (light-background fallback)", () => {
  test("finds cards on a near-white table", async () => {
    const { image, truth } = await renderTableau(allCards().slice(0, 9), {
      background: "#e8e4da", // light tan, low contrast vs card white
    });
    const quads = detectCards(cv, image);
    expect(quads).toHaveLength(9);
    const truthCentroids = truth.map((t) => centroid(t.quad));
    for (const quad of quads) {
      expect(nearestDistance(centroid(quad), truthCentroids)).toBeLessThan(20);
    }
  });
});
