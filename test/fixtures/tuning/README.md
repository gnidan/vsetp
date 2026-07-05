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
confusion matrix for any frame with a misread. It runs unconditionally
as part of `npm test`:

```bash
npx vitest run test/real-photos.test.ts
```
