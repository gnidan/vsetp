# Aspirational fixtures

Photos that are known to sit beyond v1's detection envelope. Kept for
a future model-aware detector, NOT loaded by any test suite (neither
`test/real-photos.test.ts` nor `test/fixtures.ts`'s `loadFixtures`,
which only reads `tuning/` and `holdout/`).

## pic4609830

BoardGameGeek user-uploaded image (BGG image id 4609830), added
2026-07-05. 1600x1200, dark wood table, night, steep perspective,
foreground deck stack. 12 face-up cards, labeled by hand; heavier
striped representation. Uncertain labels: the green diamonds (striped
vs open) and the red squiggle count (2 vs 3, partially judged).

Why it's out of envelope (measured during the tuning round, see
`.superpowers/sdd/tuning-report.md`, "Accepted limitation:
pic4609830"):

- Cards physically overlap within columns; no background gap exists,
  and clusters do not split under any amount of erosion (tested to
  18px working scale) because the blobs join along whole shared
  edges.
- Even fully-visible cards at this glancing angle measure
  `minAreaRect` aspect 2.4-3.1; exposed strips of overlapped cards
  measure 3.8-4.9. The steep-overlap detection strategy accepts quads
  up to aspect 5.0, but the accepted quads are the _visible strips_,
  not the full cards, so rectified reads are stretched.
- The left column (5 labels) merges into one large blob with
  incomplete edge cuts on its shadowed side and never separates. The
  deck stack region also produces one junk quad (it is genuinely
  card-shaped).

Result after the tuning round: 5/12 labels matched (6 detections),
with 4-5/5 correct color/fill and 4/5 shape among the matched cards.

Target: post-v1 model-aware detection (e.g. a card-model-aware
line-intersection quad hypothesis) — reading physically overlapping,
steeply-angled tableaus properly is not a band-tuning problem.
