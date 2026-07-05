# Holdout fixtures

Same format as tuning/. NEVER tune constants against these — they gate
deploy. If a holdout photo fails, add a _similar_ photo to tuning/,
fix against that, and only then re-run holdout.

## Running the real-photo suite

Same suite as tuning/ (`test/real-photos.test.ts`), run unconditionally
as part of `npm test` — see `../tuning/README.md`. If this directory is
empty, the suite skips cleanly.
