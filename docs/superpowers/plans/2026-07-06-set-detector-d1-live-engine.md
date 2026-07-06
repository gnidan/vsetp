# Plan D1: Live Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything live mode needs below the UI: tracker with
self-healing locks, live worker protocol + session, single-card
classification, ROI missed-card assist, pixel-only live capture, and
a scripted-sequence integration harness — all green in Node.

**Architecture:** The worker gains a live session: per frame it
detects quads, advances a track table (pure logic in
`src/worker/tracker.ts`), classifies a budgeted few tracks via a new
single-quad `readCard`, and emits one compact `live-update`. The
client gains a live API with a still/live handshake. Nothing in this
plan touches React; Plan D2 builds the UI on these interfaces.

**Tech Stack:** TypeScript, Vitest, vendored OpenCV.js 4.13.0 (Node
loader for tests), sharp (test-side rendering only).

**Spec:** `docs/superpowers/specs/2026-07-06-live-viewfinder-design.md`
(rev 2). Where this plan and the spec disagree, STOP and escalate.

## Global Constraints

- 80-char lines; double quotes; prettier-clean
  (`npx prettier --check .`).
- TDD for all pure logic: write the failing test, see it fail, then
  implement. `npx tsc -b` must be green before any commit.
- `npm test` AND `npm run build` green before every commit; read the
  FULL summary lines.
- Dependency rules (base spec): `src/model` imports nothing;
  `src/set` and `src/vision` never import each other; only
  `src/worker` + `src/vision/opencv` know OpenCV; only `src/ui`
  knows React. `src/worker/tracker.ts` imports ONLY from
  `src/model`.
- OpenCV thenable: NEVER `await` the raw module; all settling goes
  through `settleOpenCv` (existing loaders handle this — do not
  write new loader code).
- Mat lifecycle (any OpenCV code): null-init, allocate inside try,
  `?.delete()` in finally, reverse order; bind and delete
  `MatVector.get(i)` results.
- Spec constants, verbatim: `LIVE_FRAME_MAX_DIMENSION = 768`,
  `TRACK_RETIRE_FRAMES = 8`, `CONSENSUS_TO_LOCK = 3`,
  `MAX_CONSENSUS_ATTEMPTS = 7`, `CONSENSUS_GRACE_MS = 3000`.
- No React, no DOM globals in any file this plan creates (the live
  capturer uses injected minimal interfaces so it tests in Node).

---

### Task 1: Track model types + SetIdentity

**Files:**
- Create: `src/model/track.ts`
- Modify: `src/model/index.ts` (re-export)
- Create: `src/set/identity.ts`
- Test: `src/model/track.test.ts`, `src/set/identity.test.ts`

**Interfaces:**
- Consumes: `Card`, `CardKey`, `cardKey`, `Point`, `Quad`,
  `AttributeConfidence` from `src/model`.
- Produces: `TrackId`, `trackId(n)`, `TrackState`, `Track`, `Mark`,
  `MarkId`, `markId(n)` (model); `SetIdentity`,
  `setIdentityOf(cards: [Card, Card, Card])` (set). Tasks 4-8 and
  all of Plan D2 depend on these exact names.

- [ ] **Step 1: Write the failing tests**

`src/model/track.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Track } from "./track";
import { trackId } from "./track";

describe("track model", () => {
  it("brands track ids", () => {
    const id = trackId(3);
    expect(id).toBe(3);
  });

  it("carries optional reading fields as plain data", () => {
    const track: Track = {
      trackId: trackId(1),
      quad: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 6 },
        { x: 0, y: 6 },
      ],
      state: "tentative",
    };
    expect(track.reading).toBeUndefined();
    expect(track.state).toBe("tentative");
  });
});
```

`src/set/identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Card } from "../model";
import { setIdentityOf } from "./identity";

const c = (key: string): Card => {
  const [count, color, shape, fill] = key.split("-");
  return {
    count: Number(count) as Card["count"],
    color: color as Card["color"],
    shape: shape as Card["shape"],
    fill: fill as Card["fill"],
  };
};

describe("setIdentityOf", () => {
  it("is order-independent (sorted member keys)", () => {
    const a = c("1-red-oval-solid");
    const b = c("2-green-diamond-open");
    const d = c("3-purple-squiggle-striped");
    expect(setIdentityOf([a, b, d])).toBe(setIdentityOf([d, a, b]));
  });

  it("joins sorted keys with |", () => {
    const a = c("1-red-oval-solid");
    const b = c("2-green-diamond-open");
    const d = c("3-purple-squiggle-striped");
    expect(setIdentityOf([b, d, a])).toBe(
      "1-red-oval-solid|2-green-diamond-open|3-purple-squiggle-striped",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/model/track.test.ts src/set/identity.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/model/track.ts`:

```ts
import type { AttributeConfidence } from "./analysis";
import type { Card, CardKey } from "./card";
import type { Point, Quad } from "./geometry";

export type TrackId = number & { readonly __brand: "TrackId" };

export function trackId(n: number): TrackId {
  return n as TrackId;
}

export type TrackState =
  | "tentative"
  | "reading"
  | "locked"
  | "uncertain-locked";

// One tracked card as reported to the main thread: plain data, no
// pixels. trackId is stable for the track's lifetime (spec).
export interface Track {
  trackId: TrackId;
  quad: Quad;
  state: TrackState;
  reading?: Card;
  confidence?: AttributeConfidence;
  provenance?: "roi-assist";
}

export type MarkId = number & { readonly __brand: "MarkId" };

export function markId(n: number): MarkId {
  return n as MarkId;
}

// User feedback marks. Face marks key to CardKey (unique per deck);
// positional marks key to live-frame coordinates (spec).
export type Mark =
  | { type: "correct"; key: CardKey }
  | { type: "wrong"; key: CardKey }
  | { type: "not-a-card"; at: Point }
  | { type: "missed-card"; at: Point };
```

`src/set/identity.ts`:

```ts
import type { Card } from "../model";
import { cardKey } from "../model";

// Stable identity of a SET: the sorted member face keys joined.
// Used for line-color assignment and selection (spec: never key
// either to array position).
export type SetIdentity = string & { readonly __brand: "SetIdentity" };

export function setIdentityOf(cards: [Card, Card, Card]): SetIdentity {
  return cards
    .map(cardKey)
    .sort()
    .join("|") as SetIdentity;
}
```

Add to `src/model/index.ts` (alongside existing re-exports):

```ts
export * from "./track";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/model/track.test.ts src/set/identity.test.ts`
Expected: PASS. Then `npx tsc -b` clean.

- [ ] **Step 5: Full verify + commit**

Run: `npm test` and `npm run build` (full summaries green), then:

```bash
git add src/model src/set
git commit -m "Add track model types and set identity"
```

---

### Task 2: Generic Tableau<Id>

**Files:**
- Modify: `src/set/tableau.ts`
- Modify: whatever imports `Tableau`/`SetTriple`/`TableauEntry`
  concretely (run `grep -rn "SetTriple\|makeTableau\|TableauEntry" src test`
  and update type annotations only)
- Test: `src/set/tableau.test.ts` (extend existing)

**Interfaces:**
- Produces: `Tableau<Id extends number = CardId>`,
  `TableauEntry<Id extends number = CardId>`,
  `SetTriple<Id extends number = CardId> = [Id, Id, Id]`,
  `makeTableau<Id extends number = CardId>(entries) : Tableau<Id>`,
  `findSets<Id ...>(t: Tableau<Id>): SetTriple<Id>[]`,
  `hasSet<Id ...>(t): boolean`. Defaults keep every existing call
  site compiling UNCHANGED. Task 8 instantiates with `TrackId`.

- [ ] **Step 1: Write the failing test (type-level usage)**

Append to `src/set/tableau.test.ts`:

```ts
import { trackId } from "../model";
import type { TrackId } from "../model";

describe("generic tableau", () => {
  it("solves over TrackId entries", () => {
    // any three cards differing in exactly one attribute form a set
    const cards: Card[] = [
      { count: 1, color: "red", shape: "oval", fill: "solid" },
      { count: 2, color: "red", shape: "oval", fill: "solid" },
      { count: 3, color: "red", shape: "oval", fill: "solid" },
    ];
    const t = makeTableau<TrackId>(
      cards.map((card, i) => ({ id: trackId(i + 10), card })),
    );
    const sets = findSets(t);
    expect(sets).toEqual([[trackId(10), trackId(11), trackId(12)]]);
  });
});
```

(Adjust imports at the top of the file to match its existing style —
it already imports `makeTableau`, `findSets`, and `Card`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/set/tableau.test.ts`
Expected: FAIL to compile (`makeTableau` is not generic).

- [ ] **Step 3: Implement the generalization**

Rewrite `src/set/tableau.ts` — type-level only, zero runtime change:

```ts
import type { Card, CardId, CardKey } from "../model";
import { cardKey } from "../model";
import { thirdCard } from "./third-card";

export type SetTriple<Id extends number = CardId> = [Id, Id, Id];

export interface TableauEntry<Id extends number = CardId> {
  id: Id;
  card: Card;
}

// immutable snapshot of identified cards on the table
export interface Tableau<Id extends number = CardId> {
  entries: TableauEntry<Id>[];
  byKey: Map<CardKey, Id[]>; // membership multimap
}

export function makeTableau<Id extends number = CardId>(
  entries: TableauEntry<Id>[],
): Tableau<Id> {
  const byKey = new Map<CardKey, Id[]>();
  for (const { id, card } of entries) {
    const key = cardKey(card);
    const ids = byKey.get(key);
    if (ids) ids.push(id);
    else byKey.set(key, [id]);
  }
  return { entries, byKey };
}

function* triples<Id extends number>(
  t: Tableau<Id>,
): Generator<SetTriple<Id>> {
  const seen = new Set<string>();
  const { entries, byKey } = t;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const key = cardKey(thirdCard(entries[i].card, entries[j].card));
      for (const id of byKey.get(key) ?? []) {
        if (id === entries[i].id || id === entries[j].id) continue;
        const triple = [entries[i].id, entries[j].id, id].sort(
          (a, b) => a - b,
        ) as SetTriple<Id>;
        const dedup = triple.join(",");
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        yield triple;
      }
    }
  }
}

export function findSets<Id extends number = CardId>(
  t: Tableau<Id>,
): SetTriple<Id>[] {
  return [...triples(t)];
}

export function hasSet<Id extends number = CardId>(
  t: Tableau<Id>,
): boolean {
  for (const _ of triples(t)) return true;
  return false;
}
```

- [ ] **Step 4: Verify nothing else needed changes**

Run: `npx tsc -b` — the type-parameter defaults must keep every
existing call site green with NO edits. If any file fails to
compile, fix its type annotations only (e.g. an explicit
`Tableau` annotation stays valid via the default). Then
`npx vitest run src/set` — all pass including the new test.

- [ ] **Step 5: Full verify + commit**

`npm test`, `npm run build`, then:

```bash
git add src/set
git commit -m "Generalize tableau solver over branded id types"
```

---

### Task 3: readCard — single-quad classification

**Files:**
- Create: `src/vision/pipeline/read-card.ts`
- Modify: `src/vision/pipeline/analyze.ts` (use it; behavior
  identical)
- Test: `src/vision/pipeline/read-card.test.ts`

**Interfaces:**
- Consumes: `CardVision`, `whiteBalanced`, `classifyCard`,
  `orientQuad` (existing pipeline internals).
- Produces:
  `readCard(vision: CardVision, frame: ImageData, quad: Quad):
  { card: Card; confidence: AttributeConfidence; quad: Quad } | null`
  — `null` means zero symbol regions (face-down/blank; spec's
  automatic non-card elimination). The returned `quad` is the
  content-verified orientation of the input quad. Tasks 8-9 call
  this per tracked card.

- [ ] **Step 1: Write the failing test**

`src/vision/pipeline/read-card.test.ts` — reuse the existing
synthetic-card machinery. Look at how
`src/vision/pipeline/analyze.test.ts` (or the classify tests) render
a synthetic card and obtain a `CardVision`; follow the same pattern:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { cardKey } from "../../model";
import { readCard } from "./read-card";
// import the same helpers analyze.test.ts uses to get a vision
// instance and a rendered frame containing one known card at a
// known quad — copy its setup verbatim.

describe("readCard", () => {
  it("reads a single known card from its quad", () => {
    // arrange: frame with one synthetic "2-red-oval-solid" card at
    // quad Q (from the shared synthetic helper)
    const result = readCard(vision, frame, quad);
    expect(result).not.toBeNull();
    expect(cardKey(result!.card)).toBe("2-red-oval-solid");
  });

  it("returns null for a quad with no symbol regions", () => {
    // arrange: frame region that is blank white (render a blank
    // card or point the quad at empty background)
    const result = readCard(vision, frame, blankQuad);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/vision/pipeline/read-card.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement by extraction**

`src/vision/pipeline/read-card.ts`:

```ts
import type { AttributeConfidence, Card, Quad } from "../../model";
import type { CardVision } from "../adapter";
import { classifyCard } from "./classify";
import { whiteBalanced } from "./classify/pixels";
import { orientQuad } from "./orientation";

// Single-quad read: rectify -> white-balance -> segment -> classify,
// with content-verified output orientation. Returns null when the
// quad has zero symbol regions (face-down card, blank, box lid) —
// the caller must not fabricate a reading from it.
export function readCard(
  vision: CardVision,
  frame: ImageData,
  quad: Quad,
):
  | { card: Card; confidence: AttributeConfidence; quad: Quad }
  | null {
  const raster = whiteBalanced(vision.rectifyCard(frame, quad));
  const regions = vision.segmentSymbols(raster);
  if (regions.length === 0) return null;
  const { card, confidence } = classifyCard(raster, regions);
  return { card, confidence, quad: orientQuad(quad, regions, raster) };
}
```

Then rewrite the per-quad body of `analyze()` in
`src/vision/pipeline/analyze.ts` to call it, preserving timings by
timing around the call (rectify+segment+classify collapse into one
measured span; keep the same timing KEYS by attributing the whole
span to `classify` and setting `rectify`/`segment` spans via
`performance.now()` around a small inline split is NOT required —
instead keep the existing inline pipeline in `analyze()` for timings
and have it delegate the shared logic):

The clean extraction that keeps per-stage timings intact:

```ts
// in analyze.ts, replace the loop body with:
for (const quad of quads) {
  const t1 = performance.now();
  const raster = whiteBalanced(vision.rectifyCard(frame, quad));
  const t2 = performance.now();
  const regions = vision.segmentSymbols(raster);
  const t3 = performance.now();
  timings.rectify += t2 - t1;
  timings.segment += t3 - t2;
  if (regions.length === 0) continue;
  const { card, confidence } = classifyCard(raster, regions);
  timings.classify += performance.now() - t3;
  cards.push({
    id: cardId(cards.length),
    quad: orientQuad(quad, regions, raster),
    card,
    confidence,
  });
}
```

i.e. `analyze()` keeps its existing inline body (unchanged), and
`readCard` is a parallel composition of the same building blocks for
single-quad callers. Both consume the SAME four functions; there is
no duplicated logic beyond the call sequence. Do NOT force
`analyze()` through `readCard` at the cost of its per-stage timings.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/vision/pipeline` — new tests pass, all
existing pipeline + fixture tests still pass (analyze unchanged).

- [ ] **Step 5: Full verify + commit**

`npm test`, `npm run build`, then:

```bash
git add src/vision/pipeline
git commit -m "Add single-quad readCard alongside analyze"
```

---

### Task 4: Quad utils + tracker matching/aging/marks

**Files:**
- Create: `src/worker/quad-utils.ts`
- Create: `src/worker/tracker.ts` (createTrackTable, advanceTracks)
- Test: `src/worker/quad-utils.test.ts`, `src/worker/tracker.test.ts`

**Interfaces:**
- Consumes: model types from Task 1.
- Produces (Task 5 extends the same file; Tasks 8-9 consume):

```ts
// quad-utils
centroid(quad: Quad): Point
quadArea(quad: Quad): number            // shoelace
aabbIou(a: Quad, b: Quad): number       // 0..1, AABB approximation
distance(a: Point, b: Point): number

// tracker
createTrackTable(): TrackTable
advanceTracks(table: TrackTable, input: AdvanceInput): AdvanceOutput
// AdvanceInput  = { detections: Quad[]; marks: Mark[]; nowMs: number;
//                   frameSize: { width: number; height: number } }
// AdvanceOutput = { toClassify: { id: TrackId; quad: Quad }[];
//                   roiRequests: Point[] }
```

`advanceTracks` MUTATES the table (worker-local, single-threaded,
deterministic — "pure" here means no I/O, no OpenCV, no DOM).

**Constants** (define in tracker.ts, exported):

```ts
export const TRACK_RETIRE_FRAMES = 8;
export const CONSENSUS_TO_LOCK = 3;
export const MAX_CONSENSUS_ATTEMPTS = 7;
export const CONSENSUS_GRACE_MS = 3000;
export const LIVE_CLASSIFY_BUDGET = 2;
export const REVERIFY_INTERVAL_FRAMES = 24; // ~2.4s @10fps
export const UNCERTAIN_RETRY_FRAMES = 20; // ~2s @10fps
export const MIN_MATCH_IOU = 0.2;
export const CENTROID_MATCH_FACTOR = 1.5; // × sqrt(track area)
export const AREA_UNLOCK_FACTOR = 2;
export const AREA_UNLOCK_FRAMES = 2;
export const FACE_MEMORY_RADIUS_FACTOR = 0.25; // × frame diagonal
export const SUPPRESSION_RADIUS_FACTOR = 0.75; // × sqrt(area)
export const SUPPRESSION_FALLBACK_RADIUS = 40; // px, 768-space
```

**Data model** (tracker.ts):

```ts
interface Consensus {
  votes: Record<string, number>; // CardKey -> vote count
  runKey: CardKey | null; // current consecutive-agreement key
  run: number;
  attempts: number;
}

export interface TrackRecord {
  id: TrackId;
  quad: Quad;
  state: TrackState;
  reading: Card | null;
  confidence: AttributeConfidence | null;
  provenance?: "roi-assist";
  missing: number; // consecutive unmatched frames
  consensus: Consensus;
  lastClassified: number; // frame ordinal, -Infinity initially
  lastVerified: number; // frame ordinal (locked re-verify)
  lockedArea: number | null;
  bigFrames: number; // consecutive frames area > 2x lockedArea
}

export interface Suppression {
  at: Point;
  radius: number;
}

export interface GraceTally {
  at: Point;
  radius: number;
  consensus: Consensus;
  expiresAtMs: number;
}

export interface TrackTable {
  nextId: number;
  ordinal: number; // processed-frame counter
  tracks: TrackRecord[];
  faceMemory: Map<CardKey, { card: Card; lastSeenAt: Point }>;
  suppressions: Suppression[];
  grace: GraceTally[];
  roiQueue: Point[];
}
```

**advanceTracks algorithm** (implement exactly this order):

1. `table.ordinal += 1`.
2. Apply `input.marks` first:
   - `wrong`: every track whose `reading` has `cardKey === mark.key`
     → `state = "reading"`, consensus reset to
     `{ votes: {}, runKey: null, run: 0, attempts: 0 }`,
     `lockedArea = null`, `bigFrames = 0`;
     `faceMemory.delete(mark.key)` (spec: eviction).
   - `correct`: track with matching reading key → if state is
     `"reading"` or `"uncertain-locked"`, promote to `"locked"`
     (set `lockedArea = quadArea(quad)`,
     `lastVerified = table.ordinal`, and
     `faceMemory.set(key, { card, lastSeenAt: centroid(quad) })`);
     if already locked, just refresh `lastVerified`.
   - `not-a-card`: find the track whose centroid is nearest
     `mark.at` within `CENTROID_MATCH_FACTOR × sqrt(quadArea)`;
     if found, remove it and push a suppression at its centroid
     with radius `SUPPRESSION_RADIUS_FACTOR × sqrt(quadArea)`;
     if none, push suppression at `mark.at` with
     `SUPPRESSION_FALLBACK_RADIUS`.
   - `missed-card`: `table.roiQueue.push(mark.at)`.
3. Filter `input.detections`: drop any whose centroid lies within a
   suppression circle.
4. Match, two passes over remaining detections:
   - Pass A (IoU primary): consider tracks in priority order —
     `locked`/`uncertain-locked` first, then `reading`, then
     `tentative` (stable by `id` within a class). Each track takes
     the unclaimed detection with the highest
     `aabbIou(track.quad, det)` when that IoU `>= MIN_MATCH_IOU`.
   - Pass B (centroid fallback): each still-unmatched track takes
     the nearest unclaimed detection whose centroid distance is
     `<= CENTROID_MATCH_FACTOR × sqrt(quadArea(track.quad))`.
     A LOCKED track matched only by fallback gets
     `lastVerified = -Infinity` (forces earliest re-verify — the
     low-confidence-match trigger).
   - A matched track: `quad = detection`, `missing = 0`. If locked
     with `lockedArea != null`: if
     `quadArea(det) > AREA_UNLOCK_FACTOR × lockedArea` then
     `bigFrames += 1` else `bigFrames = 0`; when
     `bigFrames >= AREA_UNLOCK_FRAMES` demote to `"reading"`
     (consensus reset as in `wrong`, but do NOT evict face memory),
     keep `reading`/`confidence` values (the ghost persists while
     re-verifying).
5. Unmatched detections spawn tracks: new `TrackRecord` with
   `id = trackId(table.nextId++)`, `state = "tentative"`,
   `missing = 0`, empty consensus, `lastClassified = -Infinity`,
   `lastVerified = -Infinity`, `lockedArea = null`, `bigFrames = 0`.
   Before finalizing, check `table.grace`: a non-expired tally
   (`expiresAtMs >= input.nowMs`) whose `at` is within its `radius`
   of the new track's centroid → adopt its `consensus` (deep copy)
   and `state = "reading"`; remove the tally.
6. Unmatched tracks: `missing += 1`. When
   `missing > TRACK_RETIRE_FRAMES`, remove the track; if it was
   `"reading"` with `consensus.attempts > 0`, first push a
   `GraceTally` at its centroid with
   `radius = CENTROID_MATCH_FACTOR × sqrt(quadArea(quad))` and
   `expiresAtMs = input.nowMs + CONSENSUS_GRACE_MS`.
7. Purge expired grace tallies.
8. Build `toClassify` (budget `LIVE_CLASSIFY_BUDGET`):
   - Eligible unlocked: tracks in `tentative`/`reading`, plus
     `uncertain-locked` tracks with
     `table.ordinal - lastClassified >= UNCERTAIN_RETRY_FRAMES`.
     Sort by `lastClassified` ascending (oldest first). Take up to
     the budget. EXCLUDE tracks that were unmatched this frame
     (`missing > 0`) — their quad is stale.
   - If fewer than budget remain, fill with locked tracks due for
     re-verify (`table.ordinal - lastVerified >=
     REVERIFY_INTERVAL_FRAMES`), oldest `lastVerified` first.
   - Set `lastClassified = table.ordinal` on every selected track.
9. `roiRequests = table.roiQueue.splice(0)`.

- [ ] **Step 1: Write the failing quad-utils tests**

`src/worker/quad-utils.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Quad } from "../model";
import { aabbIou, centroid, distance, quadArea } from "./quad-utils";

const rect = (x: number, y: number, w: number, h: number): Quad => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

describe("quad-utils", () => {
  it("centroid averages corners", () => {
    expect(centroid(rect(0, 0, 10, 20))).toEqual({ x: 5, y: 10 });
  });

  it("shoelace area of an axis-aligned rect", () => {
    expect(quadArea(rect(2, 3, 10, 20))).toBe(200);
  });

  it("aabbIou of identical quads is 1", () => {
    expect(aabbIou(rect(0, 0, 10, 10), rect(0, 0, 10, 10))).toBe(1);
  });

  it("aabbIou of half-overlapping quads", () => {
    // overlap 5x10 = 50; union 100+100-50 = 150
    expect(aabbIou(rect(0, 0, 10, 10), rect(5, 0, 10, 10))).toBeCloseTo(
      50 / 150,
    );
  });

  it("aabbIou of disjoint quads is 0", () => {
    expect(aabbIou(rect(0, 0, 10, 10), rect(30, 30, 5, 5))).toBe(0);
  });

  it("distance", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});
```

- [ ] **Step 2: Implement quad-utils**

`src/worker/quad-utils.ts`:

```ts
import type { Point, Quad } from "../model";

export function centroid(quad: Quad): Point {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}

export function quadArea(quad: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function aabb(quad: Quad): { x0: number; y0: number; x1: number; y1: number } {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

// AABB approximation of IoU. Cards are near-axis-aligned rectangles
// at matching timescales (the camera moves smoothly between frames),
// so box overlap is selective enough for assignment; exact polygon
// intersection is not worth its cost here.
export function aabbIou(a: Quad, b: Quad): number {
  const ba = aabb(a);
  const bb = aabb(b);
  const ix = Math.max(
    0,
    Math.min(ba.x1, bb.x1) - Math.max(ba.x0, bb.x0),
  );
  const iy = Math.max(
    0,
    Math.min(ba.y1, bb.y1) - Math.max(ba.y0, bb.y0),
  );
  const inter = ix * iy;
  const areaA = (ba.x1 - ba.x0) * (ba.y1 - ba.y0);
  const areaB = (bb.x1 - bb.x0) * (bb.y1 - bb.y0);
  const union = areaA + areaB - inter;
  return union === 0 ? 0 : inter / union;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
```

Run: `npx vitest run src/worker/quad-utils.test.ts` — PASS.

- [ ] **Step 3: Write the failing tracker tests**

`src/worker/tracker.test.ts`. Shared helpers at the top:

```ts
import { describe, expect, it } from "vitest";
import type { Mark, Quad } from "../model";
import {
  advanceTracks,
  createTrackTable,
  LIVE_CLASSIFY_BUDGET,
  TRACK_RETIRE_FRAMES,
} from "./tracker";

const FRAME = { width: 768, height: 576 };

const rect = (x: number, y: number, w = 90, h = 58): Quad => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

function step(
  table: ReturnType<typeof createTrackTable>,
  detections: Quad[],
  marks: Mark[] = [],
  nowMs = 0,
) {
  return advanceTracks(table, {
    detections,
    marks,
    nowMs,
    frameSize: FRAME,
  });
}
```

Test cases (each a real `it` block using the helpers):

```ts
describe("advanceTracks matching", () => {
  it("spawns tentative tracks for new detections", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10), rect(200, 10)]);
    expect(table.tracks).toHaveLength(2);
    expect(table.tracks.every((t) => t.state === "tentative")).toBe(
      true,
    );
  });

  it("keeps trackId stable under drift (IoU match)", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    step(table, [rect(16, 13)]); // small drift, high IoU
    expect(table.tracks).toHaveLength(1);
    expect(table.tracks[0].id).toBe(id);
  });

  it("rejects a force-match beyond the gates (spawns instead)", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    step(table, [rect(600, 400)]); // far: no IoU, beyond centroid gate
    const ids = table.tracks.map((t) => t.id);
    expect(ids).toContain(id); // old track survives (missing=1)
    expect(table.tracks).toHaveLength(2); // far detection spawned new
  });

  it("retires a track after TRACK_RETIRE_FRAMES misses", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    for (let i = 0; i <= TRACK_RETIRE_FRAMES; i++) step(table, []);
    expect(table.tracks).toHaveLength(0);
  });

  it("dense grid: adjacent cards keep their own tracks", () => {
    const table = createTrackTable();
    // two cards 100px apart, then both drift 8px right
    step(table, [rect(100, 100), rect(200, 100)]);
    const [a, b] = table.tracks.map((t) => t.id);
    step(table, [rect(108, 100), rect(208, 100)]);
    const byX = [...table.tracks].sort(
      (t, u) => t.quad[0].x - u.quad[0].x,
    );
    expect(byX[0].id).toBe(a);
    expect(byX[1].id).toBe(b);
  });
});

describe("advanceTracks marks", () => {
  it("not-a-card removes the track and suppresses re-detections", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    step(table, [rect(10, 10)], [
      { type: "not-a-card", at: { x: 55, y: 39 } },
    ]);
    expect(table.tracks).toHaveLength(0);
    step(table, [rect(10, 10)]); // re-detected at same spot
    expect(table.tracks).toHaveLength(0); // suppressed
  });

  it("missed-card queues an roi request", () => {
    const table = createTrackTable();
    const out = step(table, [], [
      { type: "missed-card", at: { x: 300, y: 300 } },
    ]);
    expect(out.roiRequests).toEqual([{ x: 300, y: 300 }]);
    // drained: next frame has none
    expect(step(table, []).roiRequests).toEqual([]);
  });
});

describe("advanceTracks classify budget", () => {
  it("selects at most LIVE_CLASSIFY_BUDGET oldest unlocked", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10), rect(200, 10), rect(400, 10)]);
    const out = step(table, [
      rect(10, 10),
      rect(200, 10),
      rect(400, 10),
    ]);
    expect(out.toClassify).toHaveLength(LIVE_CLASSIFY_BUDGET);
  });

  it("does not classify a track that went unmatched this frame", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const out = step(table, []); // track missing this frame
    expect(out.toClassify).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run src/worker/tracker.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 5: Implement tracker.ts**

Implement the data model, constants, `createTrackTable`, and
`advanceTracks` per the algorithm above. `createTrackTable`:

```ts
export function createTrackTable(): TrackTable {
  return {
    nextId: 1,
    ordinal: 0,
    tracks: [],
    faceMemory: new Map(),
    suppressions: [],
    grace: [],
    roiQueue: [],
  };
}
```

The rest follows the numbered algorithm mechanically. Keep each
phase a named private function (`applyMarks`, `matchDetections`,
`ageTracks`, `selectClassify`) so Task 5 can extend the file without
a rewrite.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/worker` — all pass. `npx tsc -b` clean.

- [ ] **Step 7: Full verify + commit**

`npm test`, `npm run build`, then:

```bash
git add src/worker/quad-utils.ts src/worker/quad-utils.test.ts \
  src/worker/tracker.ts src/worker/tracker.test.ts
git commit -m "Add live tracker matching, aging, and marks"
```

---

### Task 5: Consensus, locking, face memory, re-verify

**Files:**
- Modify: `src/worker/tracker.ts`
- Test: `src/worker/tracker.test.ts` (extend)

**Interfaces:**
- Produces (Tasks 8-9 consume):

```ts
export interface ClassificationResult {
  id: TrackId;
  outcome: { card: Card; confidence: AttributeConfidence } | null;
}
export function applyClassifications(
  table: TrackTable,
  results: ClassificationResult[],
  nowMs: number,
): void;
export function projectTracks(table: TrackTable): Track[];
```

**applyClassifications algorithm** (per result, skip if the track no
longer exists):

1. `outcome === null` (zero regions): `consensus.attempts += 1`;
   nothing else. (A tracked quad that reads as face-down repeatedly
   will hit the escape hatch and sit uncertain — honest.)
2. Else `key = cardKey(outcome.card)`:
   - Track `"locked"`: if `key` equals the locked reading's key →
     `lastVerified = table.ordinal`, refresh
     `faceMemory.get(key).lastSeenAt = centroid(quad)`. Else →
     demote to `"reading"` with consensus
     `{ votes: { [key]: 1 }, runKey: key, run: 1, attempts: 1 }`,
     `lockedArea = null`, `bigFrames = 0`; keep displayed
     `reading`/`confidence` until a new lock replaces them. Do NOT
     touch face memory (only `wrong` evicts).
   - Track `"tentative"`/`"reading"`/`"uncertain-locked"`:
     - `"tentative"` becomes `"reading"` on first classification.
     - Face-memory validation (spec: validates, never creates), ONLY
       on the track's FIRST classification
       (`consensus.attempts === 0` before this update): if
       `faceMemory.has(key)` AND
       `distance(centroid(quad), entry.lastSeenAt) <=
       FACE_MEMORY_RADIUS_FACTOR × frameDiagonal` AND no other
       track is `"locked"` with that reading key → instant lock:
       `state = "locked"`, `reading = outcome.card`,
       `confidence = outcome.confidence`,
       `lockedArea = quadArea(quad)`,
       `lastVerified = table.ordinal`, refresh `lastSeenAt`.
       (Frame diagonal: store `frameSize` on the table in
       `advanceTracks` — add a `frameSize` field set from input.)
     - Otherwise update consensus: `votes[key] += 1`; if
       `key === runKey` then `run += 1` else
       `runKey = key, run = 1`; `attempts += 1`.
     - `run >= CONSENSUS_TO_LOCK` → lock (as above) and
       `faceMemory.set(key, { card, lastSeenAt: centroid(quad) })`.
     - Else `attempts >= MAX_CONSENSUS_ATTEMPTS` →
       `state = "uncertain-locked"`, `reading` = plurality card
       (highest vote count; ties → the current `runKey` if it is
       among the leaders, else lexicographically smallest key —
       deterministic), via `cardFromKey`; `confidence` =
       `outcome.confidence` (best available signal).

**projectTracks**: map every `TrackRecord` to the wire `Track` —
`{ trackId: id, quad, state, reading: reading ?? undefined,
confidence: confidence ?? undefined, provenance }`.

- [ ] **Step 1: Write the failing tests**

Extend `src/worker/tracker.test.ts` (reuse `step`/`rect`; add):

```ts
import { cardFromKey, cardKey } from "../model";
import type { CardKey } from "../model";
import {
  applyClassifications,
  CONSENSUS_TO_LOCK,
  MAX_CONSENSUS_ATTEMPTS,
  projectTracks,
  REVERIFY_INTERVAL_FRAMES,
} from "./tracker";

const CARD_A = cardFromKey("1-red-oval-solid" as CardKey);
const CARD_B = cardFromKey("1-red-diamond-solid" as CardKey);
const conf = { count: 1, color: 1, shape: 1, fill: 1 };

function classify(table: any, id: any, card: any, nowMs = 0) {
  applyClassifications(
    table,
    [{ id, outcome: { card, confidence: conf } }],
    nowMs,
  );
}
```

Cases:

```ts
describe("consensus and locking", () => {
  it("locks after CONSENSUS_TO_LOCK consecutive agreeing reads", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    for (let i = 0; i < CONSENSUS_TO_LOCK; i++) {
      step(table, [rect(10, 10)]);
      classify(table, id, CARD_A);
    }
    expect(table.tracks[0].state).toBe("locked");
    expect(cardKey(table.tracks[0].reading!)).toBe("1-red-oval-solid");
  });

  it("oscillating reads escape to uncertain-locked (plurality)", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    const seq = [CARD_A, CARD_B, CARD_A, CARD_B, CARD_A, CARD_B, CARD_A];
    for (const card of seq) {
      step(table, [rect(10, 10)]);
      classify(table, id, card);
    }
    expect(table.tracks[0].state).toBe("uncertain-locked");
    expect(cardKey(table.tracks[0].reading!)).toBe("1-red-oval-solid");
  });

  it("a locked track is never re-selected before the re-verify interval",
    () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    for (let i = 0; i < CONSENSUS_TO_LOCK; i++) {
      step(table, [rect(10, 10)]);
      classify(table, id, CARD_A);
    }
    const out = step(table, [rect(10, 10)]);
    expect(out.toClassify).toHaveLength(0);
  });

  it("re-verify: disagreeing re-read demotes and self-heals (swap)", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    for (let i = 0; i < CONSENSUS_TO_LOCK; i++) {
      step(table, [rect(10, 10)]);
      classify(table, id, CARD_A);
    }
    // idle past the re-verify interval; the lock becomes due
    let selected: any[] = [];
    for (let i = 0; i <= REVERIFY_INTERVAL_FRAMES; i++) {
      selected = step(table, [rect(10, 10)]).toClassify;
    }
    expect(selected.map((s) => s.id)).toContain(id);
    // the physical card was swapped: re-read disagrees
    classify(table, id, CARD_B);
    expect(table.tracks[0].state).toBe("reading");
    // consensus on the new face re-locks
    for (let i = 0; i < CONSENSUS_TO_LOCK - 1; i++) {
      step(table, [rect(10, 10)]);
      classify(table, id, CARD_B);
    }
    expect(table.tracks[0].state).toBe("locked");
    expect(cardKey(table.tracks[0].reading!)).toBe(
      "1-red-diamond-solid",
    );
  });
});

describe("face memory", () => {
  function lockAt(table: any, x: number, y: number, card: any) {
    step(table, [rect(x, y)]);
    const id = table.tracks.find(
      (t: any) => t.quad[0].x === x && t.state !== "locked",
    ).id;
    for (let i = 0; i < CONSENSUS_TO_LOCK; i++) {
      step(table, [rect(x, y)]);
      classify(table, id, card);
    }
    return id;
  }

  it("reattaches a known face near its last position instantly", () => {
    const table = createTrackTable();
    lockAt(table, 10, 10, CARD_A);
    // pan away: retire everything
    for (let i = 0; i <= TRACK_RETIRE_FRAMES; i++) step(table, []);
    expect(table.tracks).toHaveLength(0);
    // pan back: same spot, FIRST read matches memory -> instant lock
    step(table, [rect(14, 12)]);
    const id = table.tracks[0].id;
    step(table, [rect(14, 12)]);
    classify(table, id, CARD_A);
    expect(table.tracks[0].state).toBe("locked");
  });

  it("does NOT instant-lock an unknown face (validates, never creates)",
    () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const id = table.tracks[0].id;
    step(table, [rect(10, 10)]);
    classify(table, id, CARD_A); // no memory entry for CARD_A
    expect(table.tracks[0].state).toBe("reading"); // consensus path
  });

  it("rejects spatially implausible reattachment", () => {
    const table = createTrackTable();
    lockAt(table, 10, 10, CARD_A);
    for (let i = 0; i <= TRACK_RETIRE_FRAMES; i++) step(table, []);
    // reappears across the table (beyond 25% of diagonal)
    step(table, [rect(650, 500)]);
    const id = table.tracks[0].id;
    step(table, [rect(650, 500)]);
    classify(table, id, CARD_A);
    expect(table.tracks[0].state).toBe("reading"); // no teleport lock
  });

  it("never steals a key claimed by a live locked track", () => {
    const table = createTrackTable();
    lockAt(table, 10, 10, CARD_A);
    // second card nearby misread as the SAME face on first read
    step(table, [rect(10, 10), rect(140, 10)]);
    const other = table.tracks.find((t: any) => t.state === "tentative");
    step(table, [rect(10, 10), rect(140, 10)]);
    classify(table, other.id, CARD_A);
    expect(other.state).toBe("reading"); // consensus, not instant lock
  });

  it("wrong mark evicts face memory and unlocks", () => {
    const table = createTrackTable();
    lockAt(table, 10, 10, CARD_A);
    step(table, [rect(10, 10)], [
      { type: "wrong", key: cardKey(CARD_A) },
    ]);
    expect(table.tracks[0].state).toBe("reading");
    expect(table.faceMemory.has(cardKey(CARD_A))).toBe(false);
  });
});

describe("consensus grace", () => {
  it("brief occlusion preserves partial consensus", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)], [], 0);
    const id = table.tracks[0].id;
    // 2 of 3 agreeing reads
    step(table, [rect(10, 10)], [], 100);
    classify(table, id, CARD_A, 100);
    step(table, [rect(10, 10)], [], 200);
    classify(table, id, CARD_A, 200);
    // occlusion past retirement, under CONSENSUS_GRACE_MS
    for (let i = 0; i <= TRACK_RETIRE_FRAMES; i++) {
      step(table, [], [], 300 + i * 100);
    }
    expect(table.tracks).toHaveLength(0);
    // reappears in place within grace: adopts the tally
    step(table, [rect(10, 10)], [], 1500);
    const revived = table.tracks[0];
    expect(revived.state).toBe("reading");
    // ONE more agreeing read completes the 3-run
    step(table, [rect(10, 10)], [], 1600);
    classify(table, revived.id, CARD_A, 1600);
    expect(revived.state).toBe("locked");
  });
});

describe("projectTracks", () => {
  it("projects wire tracks without nulls", () => {
    const table = createTrackTable();
    step(table, [rect(10, 10)]);
    const tracks = projectTracks(table);
    expect(tracks[0]).toEqual({
      trackId: table.tracks[0].id,
      quad: table.tracks[0].quad,
      state: "tentative",
      reading: undefined,
      confidence: undefined,
      provenance: undefined,
    });
  });
});
```

Note on the grace test: adopting a 2-run tally then one agreeing
read must lock — the adopted `runKey`/`run` continue, so `run`
reaches 3 on the next agreeing read.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/worker/tracker.test.ts`
Expected: new describe blocks FAIL (functions not exported).

- [ ] **Step 3: Implement**

Add `frameSize` to `TrackTable` (`{ width, height } | null`, set on
every `advanceTracks` call), then implement `applyClassifications`
and `projectTracks` per the algorithm above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/worker` — all pass. `npx tsc -b` clean.

- [ ] **Step 5: Time-to-lock bound test**

Append and verify (documents the acceptance arithmetic):

```ts
describe("time-to-all-locked bound", () => {
  it("locks a static 20-card tableau within 60 frames", () => {
    const table = createTrackTable();
    const quads = Array.from({ length: 20 }, (_, i) =>
      rect(20 + (i % 5) * 140, 20 + Math.floor(i / 5) * 120),
    );
    const faces = allCards().slice(0, 20);
    let frames = 0;
    while (
      table.tracks.filter((t) => t.state === "locked").length < 20 &&
      frames < 60
    ) {
      const out = step(table, quads, [], frames * 100);
      const results = out.toClassify.map(({ id }) => {
        const idx = table.tracks.findIndex((t) => t.id === id);
        return { id, outcome: { card: faces[idx], confidence: conf } };
      });
      applyClassifications(table, results, frames * 100);
      frames++;
    }
    expect(frames).toBeLessThan(60); // 6s @ 10fps (spec p50 bound)
  });
});
```

(`allCards` from `src/model`.) Run and confirm PASS.

- [ ] **Step 6: Full verify + commit**

`npm test`, `npm run build`, then:

```bash
git add src/worker/tracker.ts src/worker/tracker.test.ts
git commit -m "Add consensus locking, face memory, and re-verify"
```

---

### Task 6: Live protocol + live mailbox

**Files:**
- Modify: `src/worker/protocol.ts`
- Create: `src/worker/live-mailbox.ts`
- Test: `src/worker/protocol.test.ts` (extend existing),
  `src/worker/live-mailbox.test.ts`

**Interfaces:**
- Produces: protocol families `live-start`, `live-frame`,
  `live-feedback`, `live-stop` (exact shapes below); `LiveMailbox`
  with `createLiveMailbox()`, `acceptFrame(box, pending):
  FrameId | null`, `acceptMark(box, entry): void`,
  `nextFrame(box): LivePending | null`, `drainMarks(box):
  MarkEntry[]`. Tasks 8-9 consume.

- [ ] **Step 1: Write the failing tests**

Extend `src/worker/protocol.test.ts` following its existing pattern
(it asserts guard behavior for each type tag):

```ts
it("accepts live request and response tags", () => {
  expect(isWorkerRequest({ type: "live-start" })).toBe(true);
  expect(isWorkerRequest({ type: "live-frame" })).toBe(true);
  expect(isWorkerRequest({ type: "live-feedback" })).toBe(true);
  expect(isWorkerRequest({ type: "live-stop" })).toBe(true);
  expect(isWorkerResponse({ type: "live-ready" })).toBe(true);
  expect(isWorkerResponse({ type: "live-update" })).toBe(true);
  expect(isWorkerResponse({ type: "mark-ack" })).toBe(true);
  expect(isWorkerResponse({ type: "live-stopped" })).toBe(true);
});
```

`src/worker/live-mailbox.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { frameId, markId } from "../model";
import type { Frame } from "../model";
import {
  acceptFrame,
  acceptMark,
  createLiveMailbox,
  drainMarks,
  nextFrame,
} from "./live-mailbox";

const frame = (n: number): Frame => ({
  id: frameId(n),
  width: 4,
  height: 4,
  pixels: new ArrayBuffer(64),
});

describe("live mailbox", () => {
  it("newest frame wins; displaced frame id is returned", () => {
    const box = createLiveMailbox();
    expect(acceptFrame(box, { frame: frame(1), captureMs: 1 })).toBe(
      null,
    );
    expect(acceptFrame(box, { frame: frame(2), captureMs: 1 })).toBe(
      frameId(1),
    );
    expect(nextFrame(box)?.frame.id).toBe(frameId(2));
    expect(nextFrame(box)).toBe(null);
  });

  it("marks are never dropped by frame displacement", () => {
    const box = createLiveMailbox();
    acceptFrame(box, { frame: frame(1), captureMs: 1 });
    acceptMark(box, {
      markId: markId(1),
      mark: { type: "missed-card", at: { x: 1, y: 1 } },
    });
    acceptFrame(box, { frame: frame(2), captureMs: 1 }); // displaces
    const marks = drainMarks(box);
    expect(marks).toHaveLength(1);
    expect(marks[0].markId).toBe(markId(1));
    expect(drainMarks(box)).toHaveLength(0); // drained
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/worker/protocol.test.ts src/worker/live-mailbox.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/worker/protocol.ts` — add to `WorkerProtocol` (and import
`Mark`, `MarkId`, `Track` from `../model`):

```ts
  "live-start": {
    request: { type: "live-start" };
    response: { type: "live-ready" };
  };
  "live-frame": {
    request: {
      type: "live-frame";
      frame: Frame;
      captureMs: number;
      options?: DetectOptions;
    };
    response:
      | {
          type: "live-update";
          frameId: FrameId;
          tracks: Track[];
          timings: Record<string, number>;
        }
      | { type: "dropped"; frameId: FrameId };
  };
  "live-feedback": {
    request: { type: "live-feedback"; markId: MarkId; mark: Mark };
    response: { type: "mark-ack"; markId: MarkId };
  };
  "live-stop": {
    request: { type: "live-stop" };
    response: { type: "live-stopped" };
  };
```

Extend the guard sets:

```ts
const REQUEST_TYPES = new Set<WorkerRequest["type"]>([
  "init",
  "analyze",
  "live-start",
  "live-frame",
  "live-feedback",
  "live-stop",
]);
const RESPONSE_TYPES = new Set<WorkerResponse["type"]>([
  "init-progress",
  "ready",
  "init-error",
  "result",
  "dropped",
  "analyze-error",
  "live-ready",
  "live-update",
  "mark-ack",
  "live-stopped",
]);
```

(`"dropped"` appears in both families with one wire shape — the
typed map simply names it twice; the guard set keeps one entry.)

`src/worker/live-mailbox.ts`:

```ts
import type { Frame, FrameId, Mark, MarkId } from "../model";
import type { DetectOptions } from "../vision/adapter";

export interface LivePending {
  frame: Frame;
  captureMs: number;
  options?: DetectOptions;
}

export interface MarkEntry {
  markId: MarkId;
  mark: Mark;
}

// Live variant of the depth-1 newest-wins mailbox: the frame slot
// drops stale frames, but marks queue separately and are NEVER
// dropped — displacing a frame must not discard user feedback
// (spec: live mailbox variant).
export interface LiveMailbox {
  waitingFrame: LivePending | null;
  marks: MarkEntry[];
  pumping: boolean;
}

export function createLiveMailbox(): LiveMailbox {
  return { waitingFrame: null, marks: [], pumping: false };
}

export function acceptFrame(
  box: LiveMailbox,
  incoming: LivePending,
): FrameId | null {
  const dropped = box.waitingFrame ? box.waitingFrame.frame.id : null;
  box.waitingFrame = incoming;
  return dropped;
}

export function acceptMark(box: LiveMailbox, entry: MarkEntry): void {
  box.marks.push(entry);
}

export function nextFrame(box: LiveMailbox): LivePending | null {
  const pending = box.waitingFrame;
  box.waitingFrame = null;
  return pending;
}

export function drainMarks(box: LiveMailbox): MarkEntry[] {
  return box.marks.splice(0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/worker` — all pass. `npx tsc -b` clean.

- [ ] **Step 5: Full verify + commit**

`npm test`, `npm run build`, then:

```bash
git add src/worker/protocol.ts src/worker/protocol.test.ts \
  src/worker/live-mailbox.ts src/worker/live-mailbox.test.ts
git commit -m "Add live protocol families and live mailbox"
```

---

### Task 7: ROI missed-card detection

**Files:**
- Modify: `src/vision/adapter.ts` (extend `DetectOptions`)
- Modify: `src/vision/opencv/detect.ts` (honor `relaxed`)
- Create: `src/vision/pipeline/roi.ts`
- Test: `src/vision/pipeline/roi.test.ts`

**Interfaces:**
- Produces:
  - `DetectOptions` gains `relaxed?: boolean` (default false).
  - `cropAround(frame: ImageData, at: Point, span: number):
    { image: ImageData; offset: Point }` — pure RGBA sub-rect copy,
    clamped to frame bounds; `span` = side length in px.
  - `detectCardsInRoi(vision: CardVision, frame: ImageData,
    at: Point): Quad[]` — quads in FULL-FRAME coordinates.
  - `ROI_SPAN_FACTOR = 0.35` (× frame long edge).
  Tasks 8-9 consume `detectCardsInRoi`.

- [ ] **Step 1: Write the failing tests**

`src/vision/pipeline/roi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cropAround, ROI_SPAN_FACTOR } from "./roi";

function checkerFrame(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = x === 100 && y === 50 ? 255 : 0; // one white pixel
      data[i] = v;
      data[i + 3] = 255;
    }
  return new ImageData(data, width, height);
}

describe("cropAround", () => {
  it("copies the sub-rect and reports its offset", () => {
    const frame = checkerFrame(200, 100);
    const { image, offset } = cropAround(
      frame,
      { x: 100, y: 50 },
      40,
    );
    expect(image.width).toBe(40);
    expect(image.height).toBe(40);
    const local = ((50 - offset.y) * 40 + (100 - offset.x)) * 4;
    expect(image.data[local]).toBe(255); // the white pixel came along
  });

  it("clamps at frame edges", () => {
    const frame = checkerFrame(200, 100);
    const { image, offset } = cropAround(frame, { x: 5, y: 5 }, 40);
    expect(offset).toEqual({ x: 0, y: 0 });
    expect(image.width).toBe(40);
  });

  it("exports the spec span factor", () => {
    expect(ROI_SPAN_FACTOR).toBe(0.35);
  });
});
```

Plus one REAL-photo test in the same file, following the loading
pattern in `test/real-photos.test.ts` (Node OpenCV + fixture
loader): pick one labeled card from
`test/fixtures/tuning/pic1326145.jpg`'s sidecar, load the frame at
detection scale, and assert `detectCardsInRoi(vision, frame,
labeledPoint)` returns at least one quad whose centroid is near the
label. Copy the fixture-loading helper usage from that test file
verbatim; scale the label point the same way it does.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/vision/pipeline/roi.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/vision/pipeline/roi.ts`:

```ts
import type { Point, Quad } from "../../model";
import type { CardVision } from "../adapter";

export const ROI_SPAN_FACTOR = 0.35; // of frame long edge

// Pure RGBA sub-rect copy, clamped to bounds. No OpenCV.
export function cropAround(
  frame: ImageData,
  at: Point,
  span: number,
): { image: ImageData; offset: Point } {
  const side = Math.min(span, frame.width, frame.height);
  const x0 = Math.round(
    Math.min(Math.max(at.x - side / 2, 0), frame.width - side),
  );
  const y0 = Math.round(
    Math.min(Math.max(at.y - side / 2, 0), frame.height - side),
  );
  const out = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    const src = ((y0 + y) * frame.width + x0) * 4;
    out.set(frame.data.subarray(src, src + side * 4), y * side * 4);
  }
  return { image: new ImageData(out, side, side), offset: { x: x0, y: y0 } };
}

// The missed-card assist: the user asserted a card exists here, so
// detection runs on the full-resolution crop with relaxed gates
// (spec: acceptable false-positive risk; consensus still applies).
export function detectCardsInRoi(
  vision: CardVision,
  frame: ImageData,
  at: Point,
): Quad[] {
  const span = ROI_SPAN_FACTOR * Math.max(frame.width, frame.height);
  const { image, offset } = cropAround(frame, at, span);
  const quads = vision.detectCards(image, {
    maxDimension: Math.max(image.width, image.height),
    relaxed: true,
  });
  return quads.map(
    (quad) =>
      quad.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })) as Quad,
  );
}
```

`src/vision/adapter.ts` — extend:

```ts
export interface DetectOptions {
  maxDimension?: number; // default DETECTION_MAX_DIMENSION
  relaxed?: boolean; // ROI assist: widen gates (default false)
}
```

`src/vision/opencv/detect.ts` — thread `relaxed` through: where the
aspect band and minimum-area gates are applied (read the file; the
constants are documented with fixture measurements), compute
effective bounds:

- aspect band: normal `1.05–2.35` → relaxed `0.9–2.6`
- minimum area floor: relaxed = HALF the normal floor

Implement as a small derived-limits object computed once from
`options?.relaxed` at the top of the detection entry point and
passed to the gate sites — do not fork the strategy ladder. All
other rungs/behavior unchanged. Existing detect tests must stay
green (default path identical when `relaxed` is absent).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/vision` — new tests pass AND the full
fixture suite stays green (relaxed defaults off).

- [ ] **Step 5: Full verify + commit**

`npm test`, `npm run build`, then:

```bash
git add src/vision
git commit -m "Add ROI missed-card detection with relaxed gates"
```

---

### Task 8: Live session, worker routing, client live API

**Files:**
- Create: `src/worker/live-session.ts`
- Modify: `src/worker/vision.worker.ts`
- Modify: `src/app/worker-client.ts`
- Test: `src/worker/live-session.test.ts`,
  `src/app/worker-client.test.ts` (extend existing fake-worker
  suite)

**Interfaces:**
- Produces (Plan D2 consumes the client surface):

```ts
// live-session (worker-side seam; Node-testable without a Worker)
export interface LiveSession { table: TrackTable }
export function createLiveSession(): LiveSession
export function processLiveFrame(
  vision: CardVision,
  session: LiveSession,
  pending: LivePending,
  marks: MarkEntry[],
  nowMs: number,
): { tracks: Track[]; timings: Record<string, number> }

// client additions
export interface LiveUpdate {
  frameId: FrameId;
  tracks: Track[];
  timings: Record<string, number>;
}
export class LiveSessionError extends Error {} // name set like peers
interface WorkerClient {
  // ...existing members unchanged
  startLive(onUpdate: (update: LiveUpdate) => void): Promise<void>;
  sendLiveFrame(
    frame: Frame,
    captureMs: number,
    options?: DetectOptions,
  ): void;
  sendMark(mark: Mark): Promise<void>; // resolves on mark-ack
  stopLive(): Promise<void>;
}
```

**processLiveFrame** (the whole live pipeline for one frame):

```ts
export function processLiveFrame(
  vision: CardVision,
  session: LiveSession,
  pending: LivePending,
  marks: MarkEntry[],
  nowMs: number,
): { tracks: Track[]; timings: Record<string, number> } {
  const { frame, captureMs, options } = pending;
  const timings: Record<string, number> = { capture: captureMs };
  const image = new ImageData(
    new Uint8ClampedArray(frame.pixels),
    frame.width,
    frame.height,
  );
  const t0 = performance.now();
  const detections = vision.detectCards(image, options);
  timings.detect = performance.now() - t0;

  const t1 = performance.now();
  const out = advanceTracks(session.table, {
    detections,
    marks: marks.map((entry) => entry.mark),
    nowMs,
    frameSize: { width: frame.width, height: frame.height },
  });
  const results: ClassificationResult[] = out.toClassify.map(
    ({ id, quad }) => {
      const read = readCard(vision, image, quad);
      return {
        id,
        outcome: read
          ? { card: read.card, confidence: read.confidence }
          : null,
      };
    },
  );
  applyClassifications(session.table, results, nowMs);
  timings.classify = performance.now() - t1;

  const t2 = performance.now();
  for (const at of out.roiRequests) {
    const found = detectCardsInRoi(vision, image, at);
    if (found.length > 0) {
      adoptRoiDetection(session.table, found[0]);
    }
  }
  timings.roi = performance.now() - t2;

  return { tracks: projectTracks(session.table), timings };
}
```

`adoptRoiDetection(table, quad)` is a small tracker.ts addition:
spawn a `tentative` track from the quad with
`provenance: "roi-assist"` unless its centroid is inside an
existing track's AABB (avoid duplicates) or a suppression. Export it
from tracker.ts with a unit test (two cases: adopts; skips
duplicate).

**Worker routing** (vision.worker.ts): keep the existing analyze
mailbox and pump untouched; add module state
`let live: LiveSession | null = null` and
`const liveBox = createLiveMailbox()`, plus a live pump mirroring
the analyze pump (macrotask-scheduled, newest-wins):

```ts
function livePump(): void {
  liveBox.pumping = false;
  const pending = nextFrame(liveBox);
  if (!pending || !live) return;
  const marks = drainMarks(liveBox);
  try {
    if (!vision) throw new Error("live-frame before ready");
    const { tracks, timings } = processLiveFrame(
      vision,
      live,
      pending,
      marks,
      Date.now(),
    );
    post({
      type: "live-update",
      frameId: pending.frame.id,
      tracks,
      timings,
    });
  } catch (error) {
    post({
      type: "analyze-error",
      frameId: pending.frame.id,
      stage: stage.current,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  scheduleLivePump();
}
```

Message routing additions in `scope.onmessage`:

- `live-start`: `live = createLiveSession()`; post
  `{ type: "live-ready" }`.
- `live-frame`: if `live === null`, post
  `{ type: "dropped", frameId: data.frame.id }` (benign); else
  `acceptFrame` (post `dropped` for any displaced id) and schedule
  the live pump.
- `live-feedback`: `acceptMark(liveBox, { markId, mark })`; post
  `{ type: "mark-ack", markId: data.markId }` immediately (ack =
  received; marks drain at the next processed frame).
- `live-stop`: `live = null`; clear `liveBox.waitingFrame`; post
  `{ type: "live-stopped" }`.
- `analyze` while `live !== null`: post
  `{ type: "analyze-error", frameId: data.frame.id, stage:
  "detect", message: "live session active" }` and do NOT enqueue
  (spec: worker-side handshake guard).

**Client additions** (worker-client.ts): add module state
`let liveActive = false`, `let onLiveUpdate: ((u: LiveUpdate) =>
void) | null = null`, small pending maps for the three
request/response pairs (`live-ready`, `live-stopped`, keyed
mark-acks). Behavior:

- `startLive(onUpdate)`: rejects with `LiveSessionError` if an
  analyze is pending (`pending.size > 0`) or live already active;
  awaits init (same path as analyze); posts `live-start`; resolves
  on `live-ready`; sets `liveActive`, stores callback.
- `sendLiveFrame(frame, captureMs, options)`: no-op if
  `!liveActive || fatal`; posts `live-frame` transferring
  `frame.pixels` DIRECTLY (no slice — live frames are minted fresh
  per capture and never re-analyzed; document this contrast with
  analyze()'s copy in a comment). No per-frame timer (spec:
  stall detection is the UI layer's 5s check in Plan D2).
- `analyze(...)`: add an up-front `liveActive` check → reject with
  `LiveSessionError("stop live before analyze")`.
- Response routing in `handleResponse`: `live-update` → invoke
  `onLiveUpdate`; `dropped` with a frameId NOT in `pending` while
  live → ignore (stale live frame); `mark-ack` → resolve its keyed
  pending; `live-ready`/`live-stopped` → resolve their pendings.
- `sendMark(mark)`: mints `markId(++markCounter)`, posts
  `live-feedback`, resolves on the matching `mark-ack`; rejects on
  `failAll` (add these pendings to the failAll sweep).
- `stopLive()`: if not live, resolve immediately; else post
  `live-stop`, resolve on `live-stopped`, clear `liveActive` and
  callback. Also clear both in `failAll`.

- [ ] **Step 1: Write failing live-session tests**

`src/worker/live-session.test.ts` — drive `processLiveFrame` with a
STUB `CardVision` (no OpenCV): `detectCards` returns scripted quads;
`rectifyCard`/`segmentSymbols` route through a stub that makes
`readCard` yield scripted cards. Simplest stub: make
`segmentSymbols` return one region and monkey-patch is NOT allowed —
instead build the stub so `classifyCard` sees deterministic pixels…
that is deep. Instead: test `processLiveFrame` with a vision stub
AND a scripted `readCard` by extracting the read step — give
`processLiveFrame` an injectable `read` parameter with default
`readCard`:

```ts
export function processLiveFrame(
  vision: CardVision,
  session: LiveSession,
  pending: LivePending,
  marks: MarkEntry[],
  nowMs: number,
  read: typeof readCard = readCard,
): { ... }
```

Tests then inject `read` returning scripted cards and a vision stub
whose `detectCards` returns scripted quads (its other two methods
`throw new Error("unused")`). Cases:

```ts
it("detects, tracks, classifies within budget, and projects", ...);
// scripted: 3 quads; read returns CARD_A for any quad; after 3
// frames the first two tracks are locked (budget 2/frame)

it("marks drain into the tracker (not-a-card suppresses)", ...);

it("roi request adopts a found quad with roi-assist provenance", ...);
// vision stub: detectCards returns [] for the main call (frame
// size given), and one quad for the ROI call (distinguish by the
// image size argument: ROI crops are square and smaller)

it("stamps capture and detect timings", ...);
```

- [ ] **Step 2: Implement live-session.ts + adoptRoiDetection; tests pass**

Run: `npx vitest run src/worker` — PASS. `npx tsc -b` clean.

- [ ] **Step 3: Write failing client tests**

Extend `src/app/worker-client.test.ts` using its existing fake-worker
harness (read the file; it has an `emit` helper to script responses):

```ts
it("startLive resolves on live-ready and routes live-updates", ...);
it("sendLiveFrame transfers the buffer (no slice)", ...);
// assert the fake worker received the SAME ArrayBuffer reference
// in the transfer list, and frame.pixels is in the transfer array
it("analyze rejects with LiveSessionError while live", ...);
it("startLive rejects while an analyze is pending", ...);
it("sendMark resolves on mark-ack with the same markId", ...);
it("stopLive resolves on live-stopped and re-enables analyze", ...);
it("failAll rejects pending mark and stop promises", ...);
```

- [ ] **Step 4: Implement worker routing + client; tests pass**

Run: `npx vitest run src/app src/worker` — PASS. `npx tsc -b` clean.

- [ ] **Step 5: Full verify + commit**

`npm test`, `npm run build`, then:

```bash
git add src/worker src/app
git commit -m "Add live session, worker routing, and client live API"
```

---

### Task 9: renderSequence + live integration harness

**Files:**
- Create: `test/synthetic/sequence.ts`
- Create: `test/live-integration.test.ts`

**Interfaces:**
- Consumes: the synthetic renderer in `test/synthetic/render.ts`
  (read it first — reuse its card-face rendering and any sharp
  helpers), `createLiveSession`/`processLiveFrame` (Task 8), the
  real Node OpenCV vision (same loading pattern as
  `test/real-photos.test.ts`).
- Produces: `renderSequence(spec): Promise<Frame[]>` where

```ts
export interface SequenceSpec {
  cards: { key: CardKey; at: Point }[]; // table positions (px, on
  // a WIDTHxHEIGHT synthetic table; use 1536x1152 table space)
  steps: { scale: number; dx: number; dy: number }[]; // camera path:
  // each step renders the window (table * scale, offset dx,dy)
  // downscaled to LIVE_FRAME_MAX_DIMENSION long edge
}
```

Implementation approach: render the full synthetic table ONCE to an
RGBA buffer (sharp composite of card rasters on a felt-green
background, exactly how render.ts builds single-card/tableau
images), then per step use sharp `extract` + `resize` to produce
each frame's RGBA pixels; wrap as `Frame` with `mintFrameId()`-style
local ids (`frameId(i + 1)` is fine — the ids only need uniqueness
within the test).

- [ ] **Step 1: Write renderSequence + a smoke test**

In `test/live-integration.test.ts`, first test only:

```ts
it("renderSequence produces frames of the live working size", async () => {
  const frames = await renderSequence({
    cards: [{ key: "1-red-oval-solid" as CardKey, at: { x: 300, y: 300 } }],
    steps: [
      { scale: 1, dx: 0, dy: 0 },
      { scale: 1, dx: 20, dy: 10 },
    ],
  });
  expect(frames).toHaveLength(2);
  expect(Math.max(frames[0].width, frames[0].height)).toBe(768);
});
```

Implement `test/synthetic/sequence.ts` until green.

- [ ] **Step 2: Integration scenarios (real OpenCV, real pipeline)**

Add to `test/live-integration.test.ts`, loading vision once in
`beforeAll` exactly like `test/real-photos.test.ts` does. Drive the
engine loop directly:

```ts
function runSequence(
  vision: CardVision,
  frames: Frame[],
  marksAt: Record<number, MarkEntry[]> = {},
) {
  const session = createLiveSession();
  const updates = frames.map((frame, i) =>
    processLiveFrame(
      vision,
      session,
      { frame, captureMs: 0 },
      marksAt[i] ?? [],
      i * 100,
    ),
  );
  return { session, updates };
}
```

Scenarios (each an `it`; 9-card tableau — 3×3 grid, distinct faces,
spacing ≥ 220px in table space):

1. **Drift + lock convergence:** 12 frames of ±15px drift steps.
   Assert: every update's tracks carry the SAME trackId set after
   frame 2 (continuity — no churn); by the final frame ≥ 8 of 9
   tracks are `locked`; every locked reading's `cardKey` matches
   the placed face at that position (map by centroid proximity).
2. **Pan away and return:** 5 frames on the tableau, 3 frames of
   empty felt (steps far off-table), 5 frames back. Assert: during
   the empty span tracks retire to zero; on return, tracks re-lock
   within 3 frames of reappearing (face-memory instant relock),
   and readings match the original faces.
3. **No-flicker invariant:** across ALL updates in scenario 1,
   collect `(trackId, cardKey(reading))` pairs for `locked` tracks;
   assert a trackId's locked reading NEVER changes between
   consecutive updates (locks don't flicker).

These run against real detection and classification — if the
synthetic renderer's cards defeat the classifier at 768px, scale
card size up in table space until reads are solid (the still
pipeline's synthetic tests establish workable sizes; reuse theirs).

- [ ] **Step 3: Run the integration suite**

Run: `npx vitest run test/live-integration.test.ts`
Expected: PASS (allow generous vitest timeout — set
`{ timeout: 120_000 }` on the describe; ~25 frames × real detect).

- [ ] **Step 4: Full verify + commit**

`npm test`, `npm run build`, then:

```bash
git add test/synthetic/sequence.ts test/live-integration.test.ts
git commit -m "Add live-engine integration harness with camera paths"
```

---

## Not in this plan (Plan D2 — UI)

CameraProvider hoist; `captureLiveFrame` + rVFC loop (needs DOM);
live reducer phase + events + identity-keyed `selected`; track-keyed
Overlay variant + freshness cue; feedback sheets + hit-testing +
FeedbackLog + export; adaptation ladder + 5s stall check + wake
lock; announcements (no-cards, debounce). D2 is written after D1
lands, against D1's as-built interfaces.

Note for D2 (recorded so it isn't lost): the adaptation ladder is
CLIENT-side — it adjusts `DetectOptions.maxDimension`
(768 → 640 → 512) passed with each `sendLiveFrame`; capture stays at
`LIVE_FRAME_MAX_DIMENSION = 768` throughout.
