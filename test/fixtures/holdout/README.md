# Holdout fixtures

Same format as tuning/. NEVER tune constants against these — they gate
deploy. If a holdout photo fails, add a _similar_ photo to tuning/,
fix against that, and only then re-run holdout.

## Running the real-photo suite

Same suite as tuning/ (`test/real-photos.test.ts`), same temporary
`REAL_PHOTOS=1` gate — see `../tuning/README.md`. This directory is
expected to stay empty until the tuning task lands; the suite skips
cleanly while it is.
