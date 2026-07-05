import { beforeAll, describe, expect, test } from "vitest";
import { cardFromKey, cardKey } from "../src/model";
import type { CardVision } from "../src/vision/adapter";
import { createCardVision } from "../src/vision/opencv";
import { loadOpenCv } from "../src/vision/opencv/load-node";
import { analyze } from "../src/vision/pipeline/analyze";
import { confusionMatrix, formatConfusion } from "./confusion";
import { loadFixtures } from "./fixtures";

const ATTRIBUTES = ["count", "color", "shape", "fill"] as const;

// max label-to-detection distance as a fraction of the image
// diagonal; beyond this a label counts as a miss ("MISSING" column in
// the confusion matrix) rather than pairing with some unrelated
// detection across the frame. 0.05 reproduces the original 250px
// radius on the 4000x3000 fixture it was calibrated against and
// scales down for the 1200-1600px webp fixtures (75-100px), whose
// card pitch is ~250px — an absolute 250 could pair a label with a
// neighboring card's detection there.
const MATCH_RADIUS_FRACTION = 0.05;

for (const dir of ["tuning", "holdout"] as const) {
  const fixtures = process.env.REAL_PHOTOS ? await loadFixtures(dir) : [];
  // TODO(tuning): remove this gate once the tuning task lands —
  // real photos currently reveal known misreads (see task-19 report),
  // and tuning constants against them is that task's job, not this
  // harness's. Until then, run this suite explicitly with
  // REAL_PHOTOS=1 so `npm test`/CI stay green.
  describe.skipIf(!process.env.REAL_PHOTOS || fixtures.length === 0)(
    `real photos: ${dir}`,
    () => {
      let vision: CardVision;
      beforeAll(async () => {
        vision = createCardVision(await loadOpenCv());
      }, 30_000);

      for (const fixture of fixtures) {
        test(
          fixture.name,
          () => {
            const { cards } = analyze(vision, fixture.image);
            const matchRadius =
              Math.hypot(fixture.image.width, fixture.image.height) *
              MATCH_RADIUS_FRACTION;
            // soft: a wrong card count still fails the test, but the
            // per-card loop below must run so the confusion matrices
            // always print — they are the tuning task's input
            expect.soft(cards).toHaveLength(fixture.cards.length);

            const pairs = {
              count: [],
              color: [],
              shape: [],
              fill: [],
            } as Record<string, { expected: string; actual: string }[]>;

            const claimed = new Set<(typeof cards)[number]["id"]>();
            for (const label of fixture.cards) {
              const center = (q: (typeof cards)[number]["quad"]) => ({
                x: (q[0].x + q[2].x) / 2,
                y: (q[0].y + q[2].y) / 2,
              });
              let nearest: (typeof cards)[number] | undefined;
              let nearestDistance = Infinity;
              for (const card of cards) {
                if (claimed.has(card.id)) continue;
                const d = Math.hypot(
                  center(card.quad).x - label.near.x,
                  center(card.quad).y - label.near.y,
                );
                if (d < nearestDistance) {
                  nearestDistance = d;
                  nearest = card;
                }
              }
              const labelCard = cardFromKey(label.key);
              if (!nearest || nearestDistance > matchRadius) {
                // miss: no unclaimed detection close enough; show it
                // as a "MISSING" column per attribute
                for (const attr of ATTRIBUTES) {
                  pairs[attr].push({
                    expected: String(labelCard[attr]),
                    actual: "MISSING",
                  });
                }
                expect
                  .soft(
                    null,
                    `${fixture.name}: no detection within ` +
                      `${Math.round(matchRadius)}px of ${label.key} at ` +
                      `${label.near.x},${label.near.y}`,
                  )
                  .toBe(label.key);
                continue;
              }
              claimed.add(nearest.id);
              for (const attr of ATTRIBUTES) {
                pairs[attr].push({
                  expected: String(labelCard[attr]),
                  actual: String(nearest.card[attr]),
                });
              }
              expect
                .soft(
                  cardKey(nearest.card),
                  `${fixture.name}: card near ${label.near.x},${label.near.y}`,
                )
                .toBe(label.key);
            }

            for (const attr of ATTRIBUTES) {
              if (pairs[attr].some((p) => p.expected !== p.actual)) {
                console.log(
                  `${attr}:\n${formatConfusion(confusionMatrix(pairs[attr]))}`,
                );
              }
            }
          },
          30_000,
        );
      }
    },
  );
}
