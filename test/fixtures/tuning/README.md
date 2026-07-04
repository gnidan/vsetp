# Tuning fixtures

Real photos + `<name>.json` labels
(`{ "cards": [{ "key": "2-red-oval-striped", "near": {"x": 0, "y": 0} }] }`).
Heuristic constants MAY be tuned against these. Coverage matrix lives
in the design spec (Testing ring 2): striped-at-small-scale, warm-light
purple and red, light table, touching cards, perspective, shadows,
EXIF-portrait shots.

## Running the real-photo suite

`test/real-photos.test.ts` runs every fixture in this directory (and
in `../holdout/`) through the pipeline and prints a per-attribute
confusion matrix for any frame with a misread. It is gated behind an
env flag:

```bash
REAL_PHOTOS=1 npx vitest run test/real-photos.test.ts
```

Without `REAL_PHOTOS=1` (e.g. plain `npm test`), the suite is skipped
so CI and local runs stay green while pipeline constants have not yet
been tuned against real photos.

<!-- TODO(tuning): remove this gate once the tuning task lands and the
     suite is expected to pass on tuning/ fixtures. -->
