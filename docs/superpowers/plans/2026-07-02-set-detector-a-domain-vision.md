# Set Detector Plan A: Domain + Vision Core

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The complete card-reading pipeline — domain model, set solver,
OpenCV-backed vision adapter, pure-TS classifiers, and `analyze()` —
running and tested against synthetic fixtures in Node CI.

**Architecture:** Plain-data domain (`model/`, `set/`) with zero deps; a
task-level `CardVision` adapter whose OpenCV.js implementation is the
only code that touches `cv.*`; pure-TS classification over `ImageData` +
`SymbolRegion`s; `analyze()` orchestrating it all. Fixtures are
synthetically rendered (SVG → sharp → ImageData) so CI is deterministic;
real-photo fixture machinery is scaffolded for later photo collection.

**Tech Stack:** TypeScript (strict), Vite + React 18 (scaffold only in
this plan), vitest, OpenCV.js 4.x single-threaded (vendored official
artifact), sharp (dev-only, fixture rendering).

**Spec:** `docs/superpowers/specs/2026-07-02-set-detector-design.md` —
this plan implements its `model/`, `set/`, `vision/` and testing-ring
1–2 sections. Worker, app, UI, PWA are Plans B/C.

## Global Constraints

- 80-character lines; double quotes; no getter/setter classes — plain
  data + free functions everywhere (spec + user style).
- Test files colocated with modules (`card.test.ts` next to `card.ts`);
  shared utilities and fixtures under `test/`.
- Everything crossing a boundary is structured-clone-safe plain data.
- OpenCV.js: single-threaded official artifact only; `cv.*` types never
  appear outside `src/vision/opencv/`.
- Named constants (spec values): `CARD_RASTER = 600×384`,
  `DETECTION_MAX_DIMENSION = 1024`, `NORMALIZED_MAX_DIMENSION = 3072`.
- Branded types: `CardKey`, `CardId`, `FrameId`. Never bare
  strings/numbers in public positions.
- All geometry in normalized-frame pixel coordinates; quad corner order
  is angle-about-centroid, rotated so the longest edge is the raster's
  top edge.
- `analyze` budget: ≤500ms typical on mid-tier phone; per-stage
  `timings` recorded from day one.
- Commit after every green test cycle. Commit messages: imperative,
  no scope prefixes (match existing history, e.g. "Add set solver").

---

### Task 1: Project scaffold + CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`,
  `.prettierrc.json`, `.gitignore`, `index.html`, `src/main.tsx`,
  `src/model/.gitkeep` (placeholder dirs), `test/setup.ts`,
  `.github/workflows/ci.yml`
- Test: `src/smoke.test.ts` (deleted in Task 2)

**Interfaces:**
- Produces: `npm test` (vitest run), `npm run build` (tsc + vite),
  `npm run dev`. CI running both on push.

- [ ] **Step 1: Scaffold Vite app and dev deps**

```bash
npm create vite@latest . -- --template react-ts
npm install
npm install -D vitest prettier sharp @types/node
```

- [ ] **Step 2: Configure tsconfig, prettier, vite, test setup**

`tsconfig.json` — replace compilerOptions with:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src", "test", "bin"]
}
```

`.prettierrc.json`:

```json
{ "printWidth": 80 }
```

(Double quotes are prettier's default.)

`vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/vsetp/",
  plugins: [react()],
  test: {
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
  },
});
```

`test/setup.ts` (grows in Task 7; start minimal):

```ts
// Global test setup. Node lacks browser globals that the vision code
// assumes; shims are installed here as later tasks need them.
export {};
```

`package.json` scripts (edit the generated block):

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "format": "prettier --write ."
  }
}
```

- [ ] **Step 3: Write the smoke test**

`src/smoke.test.ts`:

```ts
import { expect, test } from "vitest";

test("vitest runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 4: Run tests and build; verify both pass**

Run: `npm test` — Expected: 1 passed.
Run: `npm run build` — Expected: builds `dist/` without error.

- [ ] **Step 5: Add CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run build
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Scaffold Vite React TS app with vitest and CI"
```

---

### Task 2: Domain model — cards, keys, brands, frames

**Files:**
- Create: `src/model/card.ts`, `src/model/card.test.ts`,
  `src/model/geometry.ts`, `src/model/frame.ts`, `src/model/analysis.ts`,
  `src/model/index.ts`
- Delete: `src/smoke.test.ts`, `src/model/.gitkeep`

**Interfaces:**
- Produces (used by every later task):
  - `Card`, `Count`, `Color`, `Shape`, `Fill`
  - `CardKey`, `cardKey(card: Card): CardKey`,
    `cardFromKey(key: CardKey): Card`, `allCards(): Card[]`
  - `Point { x, y }`, `Quad = [Point, Point, Point, Point]`
  - `FrameId`, `frameId(n: number): FrameId`,
    `Frame { id, width, height, pixels: ArrayBuffer }`
  - `CardId`, `cardId(n: number): CardId`,
    `AttributeConfidence { count, color, shape, fill }`,
    `DetectedCard { id, quad, card, confidence }`,
    `FrameAnalysis { frameId, frameSize, cards, timings }`

- [ ] **Step 1: Write failing tests**

`src/model/card.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { allCards, cardFromKey, cardKey } from "./card";

describe("cardKey", () => {
  test("formats as count-color-shape-fill", () => {
    expect(
      cardKey({ count: 2, color: "red", shape: "oval", fill: "striped" }),
    ).toBe("2-red-oval-striped");
  });

  test("all 81 cards have distinct keys that round-trip", () => {
    const cards = allCards();
    expect(cards).toHaveLength(81);
    const keys = cards.map(cardKey);
    expect(new Set(keys).size).toBe(81);
    for (const card of cards) {
      expect(cardFromKey(cardKey(card))).toEqual(card);
    }
  });

  test("cardFromKey rejects malformed keys", () => {
    expect(() => cardFromKey("4-red-oval-striped" as never)).toThrow();
    expect(() => cardFromKey("nonsense" as never)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run src/model` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement the model**

`src/model/card.ts`:

```ts
export type Count = 1 | 2 | 3;
export type Color = "red" | "green" | "purple";
export type Shape = "diamond" | "oval" | "squiggle";
export type Fill = "solid" | "striped" | "open";

export interface Card {
  count: Count;
  color: Color;
  shape: Shape;
  fill: Fill;
}

// identity of a card FACE — canonical, human-readable
export type CardKey = string & { readonly __brand: "CardKey" };

// runtime attribute values are internal only (spec: no public
// enum constants); the public enumeration surface is allCards()
const COUNTS: readonly Count[] = [1, 2, 3];
const COLORS: readonly Color[] = ["red", "green", "purple"];
const SHAPES: readonly Shape[] = ["diamond", "oval", "squiggle"];
const FILLS: readonly Fill[] = ["solid", "striped", "open"];

export function cardKey(card: Card): CardKey {
  const { count, color, shape, fill } = card;
  return `${count}-${color}-${shape}-${fill}` as CardKey;
}

export function cardFromKey(key: CardKey): Card {
  const [countRaw, color, shape, fill] = key.split("-");
  const count = Number(countRaw) as Count;
  if (
    !COUNTS.includes(count) ||
    !COLORS.includes(color as Color) ||
    !SHAPES.includes(shape as Shape) ||
    !FILLS.includes(fill as Fill)
  ) {
    throw new Error(`invalid CardKey: ${key}`);
  }
  return {
    count,
    color: color as Color,
    shape: shape as Shape,
    fill: fill as Fill,
  };
}

export function allCards(): Card[] {
  const cards: Card[] = [];
  for (const count of COUNTS)
    for (const color of COLORS)
      for (const shape of SHAPES)
        for (const fill of FILLS) cards.push({ count, color, shape, fill });
  return cards;
}
```

`src/model/geometry.ts`:

```ts
export interface Point {
  x: number;
  y: number;
}

// corner order: by angle about the centroid, rotated so the longest
// edge maps to the rectified raster's top edge (see vision/quad.ts)
export type Quad = [Point, Point, Point, Point];
```

`src/model/frame.ts`:

```ts
export type FrameId = number & { readonly __brand: "FrameId" };

export function frameId(n: number): FrameId {
  return n as FrameId;
}

// the unit of pipeline input; produced by capture normalization
export interface Frame {
  id: FrameId;
  width: number;
  height: number;
  pixels: ArrayBuffer; // RGBA, width * height * 4; transferable
}
```

`src/model/analysis.ts`:

```ts
import type { Card } from "./card";
import type { FrameId } from "./frame";
import type { Quad } from "./geometry";

export type CardId = number & { readonly __brand: "CardId" };

export function cardId(n: number): CardId {
  return n as CardId;
}

export interface AttributeConfidence {
  count: number; // 0..1, per-attribute calibrated
  color: number;
  shape: number;
  fill: number;
}

export interface DetectedCard {
  id: CardId;
  quad: Quad;
  card: Card;
  confidence: AttributeConfidence;
}

export interface FrameAnalysis {
  frameId: FrameId;
  frameSize: { width: number; height: number };
  cards: DetectedCard[];
  timings: Record<string, number>; // per-stage ms
}
```

`src/model/index.ts`:

```ts
export * from "./analysis";
export * from "./card";
export * from "./frame";
export * from "./geometry";
```

Delete `src/smoke.test.ts` and `src/model/.gitkeep`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/model` — Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add domain model: cards, keys, frames, analysis types"
```

---

### Task 3: Set algebra — thirdCard and isSet

**Files:**
- Create: `src/set/third-card.ts`, `src/set/third-card.test.ts`

**Interfaces:**
- Consumes: `Card`, `cardKey`, `allCards` from `src/model`.
- Produces: `thirdCard(a: Card, b: Card): Card`,
  `isSet(a: Card, b: Card, c: Card): boolean`.

- [ ] **Step 1: Write failing tests**

`src/set/third-card.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { allCards, cardKey } from "../model";
import { isSet, thirdCard } from "./third-card";

describe("thirdCard", () => {
  test("all-same attributes stay the same", () => {
    const x = { count: 1, color: "red", shape: "oval", fill: "open" } as const;
    const y = { count: 1, color: "red", shape: "oval", fill: "solid" } as const;
    expect(thirdCard(x, y)).toEqual({
      count: 1,
      color: "red",
      shape: "oval",
      fill: "striped",
    });
  });

  test("is commutative and self-inverse over all pairs", () => {
    const cards = allCards();
    for (const x of cards) {
      for (const y of cards) {
        if (cardKey(x) === cardKey(y)) continue;
        const z = thirdCard(x, y);
        expect(cardKey(thirdCard(y, x))).toBe(cardKey(z));
        expect(cardKey(thirdCard(x, z))).toBe(cardKey(y));
        expect(isSet(x, y, z)).toBe(true);
      }
    }
  });

  test("isSet rejects a non-set", () => {
    const x = { count: 1, color: "red", shape: "oval", fill: "open" } as const;
    const y = { count: 2, color: "red", shape: "oval", fill: "open" } as const;
    const w = { count: 2, color: "green", shape: "oval", fill: "open" } as const;
    expect(isSet(x, y, w)).toBe(false);
  });
});
```

(3240 ordered pairs × a few assertions — runs in well under a second.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/set` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/set/third-card.ts`:

```ts
import type { Card, Color, Count, Fill, Shape } from "../model";
import { cardKey } from "../model";

function third<T>(all: readonly T[], a: T, b: T): T {
  if (a === b) return a;
  const rest = all.find((v) => v !== a && v !== b);
  if (rest === undefined) throw new Error("attribute domain exhausted");
  return rest;
}

const COUNTS: readonly Count[] = [1, 2, 3];
const COLORS: readonly Color[] = ["red", "green", "purple"];
const SHAPES: readonly Shape[] = ["diamond", "oval", "squiggle"];
const FILLS: readonly Fill[] = ["solid", "striped", "open"];

// the unique card completing a set with a and b
export function thirdCard(a: Card, b: Card): Card {
  return {
    count: third(COUNTS, a.count, b.count),
    color: third(COLORS, a.color, b.color),
    shape: third(SHAPES, a.shape, b.shape),
    fill: third(FILLS, a.fill, b.fill),
  };
}

export function isSet(a: Card, b: Card, c: Card): boolean {
  return cardKey(thirdCard(a, b)) === cardKey(c);
}
```

(The attribute arrays are duplicated from `model/card.ts` rather than
exported — the spec keeps runtime enum constants out of the public
model API. Two private copies, each colocated with its use.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/set` — Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add set algebra: thirdCard and isSet"
```

---

### Task 4: Tableau and findSets

**Files:**
- Create: `src/set/tableau.ts`, `src/set/tableau.test.ts`,
  `src/set/index.ts`

**Interfaces:**
- Consumes: `Card`, `CardId`, `cardId`, `CardKey`, `cardKey` from
  `src/model`; `thirdCard` from `./third-card`.
- Produces:
  - `SetTriple = [CardId, CardId, CardId]` (ascending CardId order)
  - `TableauEntry { id: CardId; card: Card }`
  - `Tableau { entries: TableauEntry[]; byKey: Map<CardKey, CardId[]> }`
  - `makeTableau(entries: TableauEntry[]): Tableau`
  - `findSets(t: Tableau): SetTriple[]` (deduplicated, each triple
    ascending)
  - `hasSet(t: Tableau): boolean`

- [ ] **Step 1: Write failing tests**

`src/set/tableau.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { Card } from "../model";
import { cardFromKey, cardId } from "../model";
import type { CardKey } from "../model";
import { findSets, hasSet, makeTableau } from "./tableau";

function entriesOf(keys: string[]) {
  return keys.map((key, i) => ({
    id: cardId(i),
    card: cardFromKey(key as CardKey) as Card,
  }));
}

describe("findSets", () => {
  test("finds the one set in a three-card tableau", () => {
    const t = makeTableau(
      entriesOf([
        "1-red-oval-solid",
        "2-red-oval-solid",
        "3-red-oval-solid",
      ]),
    );
    expect(findSets(t)).toEqual([[cardId(0), cardId(1), cardId(2)]]);
    expect(hasSet(t)).toBe(true);
  });

  test("finds no set when none exists", () => {
    const t = makeTableau(
      entriesOf([
        "1-red-oval-solid",
        "2-red-oval-solid",
        "3-green-oval-solid",
      ]),
    );
    expect(findSets(t)).toEqual([]);
    expect(hasSet(t)).toBe(false);
  });

  test("emits each set once despite multiple discovering pairs", () => {
    // 4 cards containing exactly 2 sets that share a card
    const t = makeTableau(
      entriesOf([
        "1-red-oval-solid",
        "2-red-oval-solid",
        "3-red-oval-solid",
        "1-green-diamond-open",
      ]),
    );
    const sets = findSets(t);
    expect(sets).toHaveLength(1);
  });

  test("handles duplicate faces as distinct detections", () => {
    // the same face twice: a set may use either copy, not both-as-one
    const t = makeTableau(
      entriesOf([
        "1-red-oval-solid",
        "1-red-oval-solid",
        "2-red-oval-solid",
        "3-red-oval-solid",
      ]),
    );
    const sets = findSets(t);
    // {0,2,3} and {1,2,3} — two distinct triples
    expect(sets).toEqual([
      [cardId(0), cardId(2), cardId(3)],
      [cardId(1), cardId(2), cardId(3)],
    ]);
  });

  test("never uses one detection twice in a triple", () => {
    // pair (a, a-duplicate) would complete with a itself if ids were
    // not guarded
    const t = makeTableau(
      entriesOf(["1-red-oval-solid", "1-red-oval-solid", "1-red-oval-solid"]),
    );
    // three identical faces DO form a set (all-same on every
    // attribute) using three distinct detections
    expect(findSets(t)).toEqual([[cardId(0), cardId(1), cardId(2)]]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/set` — Expected: tableau tests FAIL
(module not found), third-card tests still pass.

- [ ] **Step 3: Implement**

`src/set/tableau.ts`:

```ts
import type { Card, CardId, CardKey } from "../model";
import { cardKey } from "../model";
import { thirdCard } from "./third-card";

export type SetTriple = [CardId, CardId, CardId];

export interface TableauEntry {
  id: CardId;
  card: Card;
}

// immutable snapshot of identified cards on the table
export interface Tableau {
  entries: TableauEntry[];
  byKey: Map<CardKey, CardId[]>; // membership multimap
}

export function makeTableau(entries: TableauEntry[]): Tableau {
  const byKey = new Map<CardKey, CardId[]>();
  for (const { id, card } of entries) {
    const key = cardKey(card);
    const ids = byKey.get(key);
    if (ids) ids.push(id);
    else byKey.set(key, [id]);
  }
  return { entries, byKey };
}

function* triples(t: Tableau): Generator<SetTriple> {
  const seen = new Set<string>();
  const { entries, byKey } = t;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const key = cardKey(thirdCard(entries[i].card, entries[j].card));
      for (const id of byKey.get(key) ?? []) {
        if (id === entries[i].id || id === entries[j].id) continue;
        const triple = [entries[i].id, entries[j].id, id].sort(
          (a, b) => a - b,
        ) as SetTriple;
        const dedup = triple.join(",");
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        yield triple;
      }
    }
  }
}

export function findSets(t: Tableau): SetTriple[] {
  return [...triples(t)];
}

export function hasSet(t: Tableau): boolean {
  for (const _ of triples(t)) return true;
  return false;
}
```

`src/set/index.ts`:

```ts
export * from "./tableau";
export * from "./third-card";
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/set` — Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add tableau and pair-completion set solver"
```

---

### Task 5: Vision adapter interface and constants

**Files:**
- Create: `src/vision/adapter.ts`

**Interfaces:**
- Consumes: `Point`, `Quad` from `src/model`.
- Produces (the contract Tasks 9–18 implement/consume):
  - `DetectOptions { maxDimension?: number }`
  - `SymbolRegion { outline: Point[]; hull: Point[] }`
  - `CardVision { detectCards, rectifyCard, segmentSymbols }`
  - `CARD_RASTER = { width: 600, height: 384 }`
  - `DETECTION_MAX_DIMENSION = 1024`
  - `NORMALIZED_MAX_DIMENSION = 3072`

- [ ] **Step 1: Write the interface (types-only; no test cycle —
  compilation is the check)**

`src/vision/adapter.ts`:

```ts
import type { Point, Quad } from "../model";

// detection working scale, long edge px
export const DETECTION_MAX_DIMENSION = 1024;

// capture normalization clamp, long edge px (used in Plan B; defined
// here because it is coupled to the raster budget below)
export const NORMALIZED_MAX_DIMENSION = 3072;

// canonical rectified card raster. Long edge horizontal; sized so a
// symbol's short axis lands ~100+ px => >=8 px per stripe pair, which
// is what striped-vs-solid classification needs (see spec).
export const CARD_RASTER = { width: 600, height: 384 } as const;

export interface DetectOptions {
  maxDimension?: number; // default DETECTION_MAX_DIMENSION
}

export interface SymbolRegion {
  outline: Point[]; // filled OUTER ink boundary, raster coords
  hull: Point[]; // its convex hull
}

// The task-level vision adapter. Implementations own ALL library
// specifics (OpenCV et al.); plain data in and out.
export interface CardVision {
  // find card-shaped regions; quads in input-frame coordinates
  detectCards(frame: ImageData, options?: DetectOptions): Quad[];

  // perspective-correct one card to CARD_RASTER
  rectifyCard(frame: ImageData, quad: Quad): ImageData;

  // find symbol regions within a rectified card, fill-invariant
  segmentSymbols(card: ImageData): SymbolRegion[];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -b` — Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "Add CardVision adapter interface and constants"
```

---

### Task 6: Quad corner ordering (pure geometry)

**Files:**
- Create: `src/vision/quad.ts`, `src/vision/quad.test.ts`

**Interfaces:**
- Consumes: `Point`, `Quad` from `src/model`.
- Produces: `orderQuad(points: Point[]): Quad` — the spec's corner
  rule: order by angle about the centroid (clockwise in screen coords),
  then rotate the ordering so the longest edge is first (maps to the
  raster's top edge). Used by `detectCards` (Task 9) and tests.

- [ ] **Step 1: Write failing tests**

`src/vision/quad.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { Point } from "../model";
import { orderQuad } from "./quad";

function edgeLength(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

describe("orderQuad", () => {
  test("longest edge comes first regardless of input order", () => {
    // landscape 200x100 rectangle, corners shuffled
    const shuffled: Point[] = [
      { x: 200, y: 100 },
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 0, y: 100 },
    ];
    const q = orderQuad(shuffled);
    expect(edgeLength(q[0], q[1])).toBeCloseTo(200);
  });

  test("orders a rotated rectangle consistently", () => {
    // 200x100 rectangle rotated 30 degrees about its center
    const c = { x: 100, y: 50 };
    const rot = (p: Point): Point => {
      const rad = (30 * Math.PI) / 180;
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      return {
        x: c.x + dx * Math.cos(rad) - dy * Math.sin(rad),
        y: c.y + dx * Math.sin(rad) + dy * Math.cos(rad),
      };
    };
    const corners: Point[] = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ].map(rot);
    const q = orderQuad([corners[2], corners[0], corners[3], corners[1]]);
    // first edge is one of the two long edges
    expect(edgeLength(q[0], q[1])).toBeCloseTo(200, 0);
    // consecutive corners are adjacent (perimeter order, no diagonals)
    expect(edgeLength(q[1], q[2])).toBeCloseTo(100, 0);
    expect(edgeLength(q[2], q[3])).toBeCloseTo(200, 0);
  });

  test("throws unless given exactly 4 points", () => {
    expect(() => orderQuad([{ x: 0, y: 0 }])).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/vision/quad.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/vision/quad.ts`:

```ts
import type { Point, Quad } from "../model";

// Order 4 corners: clockwise (screen coords) by angle about the
// centroid, then rotated so the longest edge is (q[0] -> q[1]). This
// fixes orientation up to a 180-degree flip, which classification is
// deliberately invariant to (see spec).
export function orderQuad(points: Point[]): Quad {
  if (points.length !== 4) {
    throw new Error(`orderQuad needs 4 points, got ${points.length}`);
  }
  const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
  const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;
  const byAngle = [...points].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  let longest = 0;
  let longestLength = -1;
  for (let i = 0; i < 4; i++) {
    const a = byAngle[i];
    const b = byAngle[(i + 1) % 4];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > longestLength) {
      longestLength = length;
      longest = i;
    }
  }
  return [
    byAngle[longest],
    byAngle[(longest + 1) % 4],
    byAngle[(longest + 2) % 4],
    byAngle[(longest + 3) % 4],
  ] as Quad;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/vision/quad.test.ts` — Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add perspective-robust quad corner ordering"
```

---

### Task 7: Vendor OpenCV.js + Node loader + ImageData shim

**Files:**
- Create: `bin/fetch-opencv.sh`, `public/vendor/` (vendored
  `opencv-4.13.0.js`, committed), `src/vision/opencv/cv.ts`,
  `src/vision/opencv/load-node.ts`, `src/vision/opencv/load-node.test.ts`
- Modify: `test/setup.ts`

**Interfaces:**
- Produces:
  - `type Cv` in `src/vision/opencv/cv.ts` — deliberately `any`,
    confined to `src/vision/opencv/`; its own file so browser code
    (Plan B) never imports the Node loader
  - `loadOpenCv(): Promise<Cv>` (Node path; cached singleton)
  - global `ImageData` available in Node tests
  - `OPENCV_VENDOR_FILE = "opencv-4.13.0.js"` exported for reuse
- Notes: the single-file official artifact embeds the WASM; it is the
  single-threaded build (GitHub Pages cannot serve COOP/COEP). The same
  vendored file serves browser loading in Plan B (streamed fetch +
  progress); committing it keeps builds deterministic and its URL
  content-named/stable across deploys per spec.

- [ ] **Step 1: Write the fetch script and vendor the artifact**

`bin/fetch-opencv.sh`:

```bash
#!/usr/bin/env bash
# Vendors the official single-file OpenCV.js build (WASM embedded,
# single-threaded). Committed to git; rerun only to change versions.
set -euo pipefail
version="4.13.0"
out="$(dirname "$0")/../public/vendor/opencv-${version}.js"
mkdir -p "$(dirname "$out")"
curl -fL "https://docs.opencv.org/${version}/opencv.js" -o "$out"
shasum -a 256 "$out"
echo "vendored $out"
```

Run: `chmod +x bin/fetch-opencv.sh && ./bin/fetch-opencv.sh`
Expected: `public/vendor/opencv-4.13.0.js` exists (~10MB); note the
printed sha256 in the commit message for provenance.

- [ ] **Step 2: Add the ImageData shim to test setup**

`test/setup.ts` (replace contents):

```ts
// Node lacks ImageData; the vision code passes it across the adapter
// boundary. Minimal spec-shaped shim, installed only when absent.
if (typeof globalThis.ImageData === "undefined") {
  class NodeImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    readonly colorSpace = "srgb";

    constructor(dataOrWidth: Uint8ClampedArray | number, w: number, h?: number) {
      if (typeof dataOrWidth === "number") {
        this.width = dataOrWidth;
        this.height = w;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      } else {
        this.data = dataOrWidth;
        this.width = w;
        this.height = h ?? dataOrWidth.length / 4 / w;
        if (dataOrWidth.length !== this.width * this.height * 4) {
          throw new Error("ImageData: data length mismatch");
        }
      }
    }
  }
  (globalThis as Record<string, unknown>).ImageData = NodeImageData;
}
export {};
```

- [ ] **Step 3: Write the failing loader test**

`src/vision/opencv/load-node.test.ts`:

```ts
import { beforeAll, expect, test } from "vitest";
import type { Cv } from "./cv";
import { loadOpenCv } from "./load-node";

let cv: Cv;

beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000); // WASM init is slow; known vitest hang risk — keep timeout

test("initializes and round-trips a Mat from ImageData", () => {
  const image = new ImageData(4, 3);
  image.data.fill(255);
  const mat = cv.matFromImageData(image);
  expect(mat.rows).toBe(3);
  expect(mat.cols).toBe(4);
  mat.delete();
});

test("loadOpenCv is a cached singleton", async () => {
  expect(await loadOpenCv()).toBe(cv);
});
```

Run: `npx vitest run src/vision/opencv` — Expected: FAIL (module not
found).

- [ ] **Step 4: Implement the Node loader**

`src/vision/opencv/cv.ts`:

```ts
// OpenCV.js ships no usable types; `any` is deliberate and confined
// to src/vision/opencv/ (adapter boundary rule).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Cv = any;

export const OPENCV_VENDOR_FILE = "opencv-4.13.0.js";
```

`src/vision/opencv/load-node.ts`:

```ts
import { createRequire } from "node:module";
import type { Cv } from "./cv";
import { OPENCV_VENDOR_FILE } from "./cv";

let cached: Promise<Cv> | undefined;

async function initialize(): Promise<Cv> {
  const require = createRequire(import.meta.url);
  const loaded = require(`../../../public/vendor/${OPENCV_VENDOR_FILE}`);
  const cv = typeof loaded === "function" ? await loaded() : loaded;
  if (cv && typeof cv.then === "function") return await cv;
  if (cv.Mat) return cv; // already initialized
  return new Promise<Cv>((resolve) => {
    cv.onRuntimeInitialized = () => resolve(cv);
  });
}

// Node-side loader for tests/tools. The browser/worker loader (streamed
// fetch with download progress) is Plan B; both consume the same
// vendored artifact.
export function loadOpenCv(): Promise<Cv> {
  cached ??= initialize();
  return cached;
}
```

- [ ] **Step 5: Run to verify pass; commit**

Run: `npx vitest run src/vision/opencv` — Expected: 2 passed (first
run takes several seconds for WASM init).

```bash
git add -A
git commit -m "Vendor OpenCV.js 4.13.0 single-threaded build with Node loader

sha256 <paste from fetch script output>"
```

---

### Task 8: Synthetic fixture renderer

**Files:**
- Create: `test/synthetic/render.ts`, `test/synthetic/render.test.ts`

**Interfaces:**
- Consumes: `Card`, `Quad`, `CARD_RASTER`.
- Produces (consumed by every vision test, Tasks 9–18):
  - `renderCardRaster(card: Card): Promise<ImageData>` — one card at
    `CARD_RASTER` size, white background, as if already rectified
  - `renderTableau(cards: Card[], opts?: TableauOptions): Promise<Tableau­Render>`
    where `TableauRender = { image: ImageData; truth: TruthCard[] }`,
    `TruthCard = { card: Card; quad: Quad }` (quads in frame coords,
    corner order matching `orderQuad` semantics is NOT guaranteed —
    tests compare by centroid, not corner-by-corner)
  - `TableauOptions { width?: number; height?: number; background?:
    string; rotate?: boolean }` — defaults 1600×1200, felt green
    `#2e6b4f`, deterministic per-card rotation (index-seeded, ±6°)
- Notes: sharp rasterizes SVG via libvips. Symbols are drawn in a
  120×240 box (short axis 120 ⇒ stripes at 14px spacing ≈ 8 stripe
  pairs — matches the spec's raster budget). The squiggle stands in as
  a smooth *non-convex* pinched shape: what matters to the classifier
  is convexity defects, not the exact Set glyph. Real-photo fixtures
  (Task 18) are the ground truth for glyph fidelity.

- [ ] **Step 1: Write failing sanity tests**

`test/synthetic/render.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { CARD_RASTER } from "../../src/vision/adapter";
import { renderCardRaster, renderTableau } from "./render";

function pixelAt(image: ImageData, x: number, y: number) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

describe("renderCardRaster", () => {
  test("renders at CARD_RASTER size with white border", async () => {
    const image = await renderCardRaster({
      count: 1,
      color: "red",
      shape: "oval",
      fill: "solid",
    });
    expect(image.width).toBe(CARD_RASTER.width);
    expect(image.height).toBe(CARD_RASTER.height);
    const [r, g, b] = pixelAt(image, 5, 5); // border is card-white
    expect(r).toBeGreaterThan(230);
    expect(g).toBeGreaterThan(230);
    expect(b).toBeGreaterThan(230);
  });

  test("solid red card has red center pixel", async () => {
    const image = await renderCardRaster({
      count: 1,
      color: "red",
      shape: "oval",
      fill: "solid",
    });
    const [r, g, b] = pixelAt(image, image.width / 2, image.height / 2);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(120);
    expect(b).toBeLessThan(120);
  });

  test("open card has white center pixel", async () => {
    const image = await renderCardRaster({
      count: 1,
      color: "red",
      shape: "oval",
      fill: "open",
    });
    const [r, g, b] = pixelAt(image, image.width / 2, image.height / 2);
    expect(r).toBeGreaterThan(230);
    expect(g).toBeGreaterThan(230);
    expect(b).toBeGreaterThan(230);
  });
});

describe("renderTableau", () => {
  test("renders cards with in-bounds ground-truth quads", async () => {
    const cards = [
      { count: 1, color: "red", shape: "oval", fill: "solid" },
      { count: 2, color: "green", shape: "diamond", fill: "striped" },
      { count: 3, color: "purple", shape: "squiggle", fill: "open" },
    ] as const;
    const { image, truth } = await renderTableau([...cards]);
    expect(image.width).toBe(1600);
    expect(truth).toHaveLength(3);
    for (const { quad } of truth) {
      for (const p of quad) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(image.width);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(image.height);
      }
    }
  });
});
```

Run: `npx vitest run test/synthetic` — Expected: FAIL.

- [ ] **Step 2: Implement the renderer**

`test/synthetic/render.ts`:

```ts
import sharp from "sharp";
import type { Card, Color, Fill, Quad, Shape } from "../../src/model";
import { CARD_RASTER } from "../../src/vision/adapter";

const INK: Record<Color, string> = {
  red: "#d43a2f",
  green: "#3fa652",
  purple: "#6a2c91",
};

// symbol box; short axis 120 => stripe spacing 14 ~= 8 stripe pairs
const SYMBOL = { width: 120, height: 240 };

function symbolShape(shape: Shape): string {
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
    case "squiggle":
      // smooth pinched (non-convex) stand-in: what the shape
      // classifier keys on is convexity defects vs. smooth ovals
      return (
        `M 60 10 C 105 10 120 55 100 85 C 88 103 88 137 100 155 ` +
        `C 120 185 105 230 60 230 C 15 230 0 185 20 155 ` +
        `C 32 137 32 103 20 85 C 0 55 15 10 60 10 Z`
      );
  }
}

function fillAttrs(fill: Fill, color: Color, patternId: string): string {
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

function stripePattern(patternId: string, color: Color): string {
  return (
    `<pattern id="${patternId}" width="14" height="14" ` +
    `patternUnits="userSpaceOnUse">` +
    `<rect width="14" height="14" fill="#ffffff"/>` +
    `<line x1="4" y1="0" x2="4" y2="14" stroke="${INK[color]}" ` +
    `stroke-width="5"/></pattern>`
  );
}

// SVG for one card face of the given pixel size (white rounded rect
// plus a centered row of `count` symbols), origin at (0, 0)
function cardFaceSvg(card: Card, width: number, height: number): string {
  const patternId = `stripe-${card.color}`;
  const scale = height / (CARD_RASTER.height as number);
  const gap = 24;
  const rowWidth =
    card.count * SYMBOL.width + (card.count - 1) * gap;
  const symbols: string[] = [];
  for (let i = 0; i < card.count; i++) {
    const x =
      (CARD_RASTER.width - rowWidth) / 2 + i * (SYMBOL.width + gap);
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
    `</g>` +
    `<!-- face ${width}x${height} -->`
  );
}

async function rasterize(svg: string): Promise<ImageData> {
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new ImageData(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
    info.width,
    info.height,
  );
}

export async function renderCardRaster(card: Card): Promise<ImageData> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${CARD_RASTER.width}" height="${CARD_RASTER.height}">` +
    cardFaceSvg(card, CARD_RASTER.width, CARD_RASTER.height) +
    `</svg>`;
  return rasterize(svg);
}

export interface TruthCard {
  card: Card;
  quad: Quad;
}

export interface TableauRender {
  image: ImageData;
  truth: TruthCard[];
}

export interface TableauOptions {
  width?: number;
  height?: number;
  background?: string;
  rotate?: boolean;
}

function rotatedQuad(
  x: number,
  y: number,
  w: number,
  h: number,
  degrees: number,
): Quad {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rad = (degrees * Math.PI) / 180;
  const rot = (px: number, py: number) => ({
    x: cx + (px - cx) * Math.cos(rad) - (py - cy) * Math.sin(rad),
    y: cy + (px - cx) * Math.sin(rad) + (py - cy) * Math.cos(rad),
  });
  return [
    rot(x, y),
    rot(x + w, y),
    rot(x + w, y + h),
    rot(x, y + h),
  ] as Quad;
}

export async function renderTableau(
  cards: Card[],
  options: TableauOptions = {},
): Promise<TableauRender> {
  const width = options.width ?? 1600;
  const height = options.height ?? 1200;
  const background = options.background ?? "#2e6b4f";
  const rotate = options.rotate ?? true;
  const cardW = 300;
  const cardH = 192;
  const columns = 4;
  const gapX = (width - columns * cardW) / (columns + 1);
  const rows = Math.ceil(cards.length / columns);
  const gapY = (height - rows * cardH) / (rows + 1);

  const pieces: string[] = [];
  const truth: TruthCard[] = [];
  cards.forEach((card, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = gapX + col * (cardW + gapX);
    const y = gapY + row * (cardH + gapY);
    // deterministic pseudo-random rotation, +-6 degrees
    const degrees = rotate ? ((i * 37) % 13) - 6 : 0;
    pieces.push(
      `<g transform="translate(${x} ${y}) ` +
        `rotate(${degrees} ${cardW / 2} ${cardH / 2})">` +
        cardFaceSvg(card, cardW, cardH) +
        `</g>`,
    );
    truth.push({ card, quad: rotatedQuad(x, y, cardW, cardH, degrees) });
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="${background}"/>` +
    pieces.join("") +
    `</svg>`;
  return { image: await rasterize(svg), truth };
}
```

- [ ] **Step 3: Run to verify pass**

Run: `npx vitest run test/synthetic` — Expected: 4 passed.

Note: `cardFaceSvg` embeds one stripe `<pattern>` def per `<g>`; with
multiple striped cards of the same color the duplicate ids are
harmless (first definition wins, all identical).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Add synthetic SVG fixture renderer for vision tests"
```

---

### Task 9: detectCards — primary path

**Files:**
- Create: `src/vision/opencv/detect.ts`, `src/vision/opencv/detect.test.ts`

**Interfaces:**
- Consumes: `Cv` (`./cv`), `loadOpenCv` (`./load-node`, tests only),
  `orderQuad` (`../quad`), `DetectOptions`, `DETECTION_MAX_DIMENSION`
  (`../adapter`), `renderTableau` (`test/synthetic/render`).
- Produces: `detectCards(cv: Cv, frame: ImageData, options?:
  DetectOptions): Quad[]` — quads in input-frame coords, corner order
  per `orderQuad`, sorted by centroid (y, then x) for determinism.
- Implementation note (spec deviation, justified): the spec sketch says
  "adaptive threshold"; local-adaptive thresholding hollows out large
  uniform card interiors (the neighborhood mean *is* the card), so the
  primary path uses **Otsu's global threshold** (adaptively chosen
  level) + morphological open. The light-background *fallback* (Task
  10) covers what local-adaptive was for. A light erosion is always
  applied to separate near-touching cards; corners are compensated
  outward afterward. Truly overlapping cards (gap 0) remain for the
  distance-transform + watershed escalation, which per spec is
  implemented when real-photo fixtures demand it — record it as a noted
  limitation in that task, not silently.

- [ ] **Step 1: Write failing tests**

`src/vision/opencv/detect.test.ts`:

```ts
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
      expect(nearestDistance(centroid(quad), truthCentroids)).toBeLessThan(
        15,
      );
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
```

Run: `npx vitest run src/vision/opencv/detect.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/vision/opencv/detect.ts`:

```ts
import type { Point, Quad } from "../../model";
import type { DetectOptions } from "../adapter";
import { DETECTION_MAX_DIMENSION } from "../adapter";
import { orderQuad } from "../quad";
import type { Cv } from "./cv";

// erosion radius (working-scale px) used to split near-touching cards;
// corners are compensated outward by the same amount afterward
const SPLIT_EROSION = 2;
const MIN_CARD_AREA_FRACTION = 0.003;
const MAX_CARD_AREA_FRACTION = 0.25;
const CARD_ASPECT_RANGE = { min: 1.2, max: 2.0 };

interface Candidate {
  points: Point[]; // 4 corners, working scale
}

function candidatesFromBinary(cv: Cv, binary: Cv): Candidate[] {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(
    binary,
    contours,
    hierarchy,
    cv.RETR_EXTERNAL,
    cv.CHAIN_APPROX_SIMPLE,
  );
  const found: Candidate[] = [];
  const imageArea = binary.rows * binary.cols;
  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);
    if (
      area < imageArea * MIN_CARD_AREA_FRACTION ||
      area > imageArea * MAX_CARD_AREA_FRACTION
    ) {
      contour.delete();
      continue;
    }
    const approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, 0.02 * cv.arcLength(contour, true), true);
    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      const rect = cv.minAreaRect(approx);
      const long = Math.max(rect.size.width, rect.size.height);
      const short = Math.min(rect.size.width, rect.size.height);
      const aspect = long / Math.max(short, 1);
      if (aspect >= CARD_ASPECT_RANGE.min && aspect <= CARD_ASPECT_RANGE.max) {
        const points: Point[] = [];
        for (let p = 0; p < 4; p++) {
          points.push({
            x: approx.data32S[p * 2],
            y: approx.data32S[p * 2 + 1],
          });
        }
        found.push({ points });
      }
    }
    approx.delete();
    contour.delete();
  }
  contours.delete();
  hierarchy.delete();
  return found;
}

function grow(points: Point[], by: number): Point[] {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return points.map((p) => {
    const d = Math.hypot(p.x - cx, p.y - cy) || 1;
    return { x: p.x + ((p.x - cx) / d) * by, y: p.y + ((p.y - cy) / d) * by };
  });
}

export function detectCards(
  cv: Cv,
  frame: ImageData,
  options?: DetectOptions,
): Quad[] {
  const maxDimension = options?.maxDimension ?? DETECTION_MAX_DIMENSION;
  const scale = Math.min(
    1,
    maxDimension / Math.max(frame.width, frame.height),
  );
  const src = cv.matFromImageData(frame);
  const working = new cv.Mat();
  const binary = new cv.Mat();
  const kernel = cv.getStructuringElement(
    cv.MORPH_ELLIPSE,
    new cv.Size(2 * SPLIT_EROSION + 1, 2 * SPLIT_EROSION + 1),
  );
  try {
    cv.resize(
      src,
      working,
      new cv.Size(
        Math.round(frame.width * scale),
        Math.round(frame.height * scale),
      ),
      0,
      0,
      cv.INTER_AREA,
    );
    cv.cvtColor(working, working, cv.COLOR_RGBA2GRAY);
    cv.threshold(working, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.erode(binary, binary, kernel);
    const candidates = candidatesFromBinary(cv, binary);
    return candidates
      .map((c) =>
        orderQuad(
          grow(c.points, SPLIT_EROSION).map((p) => ({
            x: p.x / scale,
            y: p.y / scale,
          })),
        ),
      )
      .sort((a, b) => {
        const ca = a.reduce((s, p) => s + p.y, 0);
        const cb = b.reduce((s, p) => s + p.y, 0);
        return ca - cb || a[0].x - b[0].x;
      });
  } finally {
    kernel.delete();
    binary.delete();
    working.delete();
    src.delete();
  }
}
```

- [ ] **Step 3: Run to verify pass**

Run: `npx vitest run src/vision/opencv/detect.test.ts`
Expected: 3 passed. If the touching-cards case fails, tune
`SPLIT_EROSION` (2–4) before touching anything else.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Add card detection primary path (Otsu + contours)"
```

---

### Task 10: detectCards — low-contrast fallback

**Files:**
- Modify: `src/vision/opencv/detect.ts`
- Test: `src/vision/opencv/detect.test.ts` (add cases)

**Interfaces:**
- Produces: same `detectCards` signature; internally tries the primary
  path, and when it finds fewer than `MIN_PLAUSIBLE_CARDS = 3` quads,
  runs an edge-based fallback (Canny + dilate to close soft borders)
  and returns whichever result found more cards.

- [ ] **Step 1: Add failing tests**

Append to `src/vision/opencv/detect.test.ts`:

```ts
describe("detectCards (light-background fallback)", () => {
  test("finds cards on a near-white table", async () => {
    const { image, truth } = await renderTableau(allCards().slice(0, 9), {
      background: "#e8e4da", // light tan, low contrast vs card white
    });
    const quads = detectCards(cv, image);
    expect(quads).toHaveLength(9);
    const truthCentroids = truth.map((t) => centroid(t.quad));
    for (const quad of quads) {
      expect(nearestDistance(centroid(quad), truthCentroids)).toBeLessThan(
        20,
      );
    }
  });
});
```

Run: `npx vitest run src/vision/opencv/detect.test.ts`
Expected: new case FAILS (Otsu can't split white-on-near-white), old
cases pass.

- [ ] **Step 2: Implement the fallback**

In `src/vision/opencv/detect.ts`, add:

```ts
const MIN_PLAUSIBLE_CARDS = 3;

// Edge-based fallback for white-cards-on-light-tables: card borders
// survive as gradients even when no threshold separates the regions.
function binaryFromEdges(cv: Cv, gray: Cv): Cv {
  const edges = new cv.Mat();
  const kernel = cv.getStructuringElement(
    cv.MORPH_ELLIPSE,
    new cv.Size(5, 5),
  );
  cv.Canny(gray, edges, 40, 120);
  cv.dilate(edges, edges, kernel); // seal soft/broken card borders
  // cards become rings; fill them so external contours are card blobs
  const filled = new cv.Mat();
  cv.morphologyEx(
    edges,
    filled,
    cv.MORPH_CLOSE,
    kernel,
    new cv.Point(-1, -1),
    2,
  );
  edges.delete();
  kernel.delete();
  return filled;
}
```

Replace `detectCards` in full (strategy-driven thresholding; the
standalone `binary` Mat and its `finally` entry go away — each strategy
owns its binary Mat):

```ts
export function detectCards(
  cv: Cv,
  frame: ImageData,
  options?: DetectOptions,
): Quad[] {
  const maxDimension = options?.maxDimension ?? DETECTION_MAX_DIMENSION;
  const scale = Math.min(
    1,
    maxDimension / Math.max(frame.width, frame.height),
  );
  const src = cv.matFromImageData(frame);
  const working = new cv.Mat();
  const kernel = cv.getStructuringElement(
    cv.MORPH_ELLIPSE,
    new cv.Size(2 * SPLIT_EROSION + 1, 2 * SPLIT_EROSION + 1),
  );
  try {
    cv.resize(
      src,
      working,
      new cv.Size(
        Math.round(frame.width * scale),
        Math.round(frame.height * scale),
      ),
      0,
      0,
      cv.INTER_AREA,
    );
    cv.cvtColor(working, working, cv.COLOR_RGBA2GRAY);

    const strategies = [
      () => {
        const binary = new cv.Mat();
        cv.threshold(
          working,
          binary,
          0,
          255,
          cv.THRESH_BINARY + cv.THRESH_OTSU,
        );
        cv.erode(binary, binary, kernel);
        return binary;
      },
      () => binaryFromEdges(cv, working),
    ];

    let best: Candidate[] = [];
    for (const strategy of strategies) {
      const binary = strategy();
      const candidates = candidatesFromBinary(cv, binary);
      binary.delete();
      if (candidates.length > best.length) best = candidates;
      if (best.length >= MIN_PLAUSIBLE_CARDS) break;
    }

    return best
      .map((c) =>
        orderQuad(
          grow(c.points, SPLIT_EROSION).map((p) => ({
            x: p.x / scale,
            y: p.y / scale,
          })),
        ),
      )
      .sort((a, b) => {
        const ca = a.reduce((s, p) => s + p.y, 0);
        const cb = b.reduce((s, p) => s + p.y, 0);
        return ca - cb || a[0].x - b[0].x;
      });
  } finally {
    kernel.delete();
    working.delete();
    src.delete();
  }
}
```

Note: `binaryFromEdges` candidates carry the dilation margin instead of
the erosion deficit; `grow(c.points, SPLIT_EROSION)` overcorrects
slightly for them. The 20px centroid tolerance absorbs this; real-photo
fixtures decide whether per-strategy compensation is worth it.

- [ ] **Step 3: Run to verify pass**

Run: `npx vitest run src/vision/opencv/detect.test.ts`
Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Add edge-based detection fallback for light tables"
```

---

### Task 11: rectifyCard

**Files:**
- Create: `src/vision/opencv/rectify.ts`,
  `src/vision/opencv/rectify.test.ts`

**Interfaces:**
- Consumes: `Cv`, `CARD_RASTER`, `Quad`.
- Produces: `rectifyCard(cv: Cv, frame: ImageData, quad: Quad):
  ImageData` — always `CARD_RASTER`-sized; `quad[0]→quad[1]` (the
  longest edge, per `orderQuad`) maps to the raster's top edge.

- [ ] **Step 1: Write failing tests**

`src/vision/opencv/rectify.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "vitest";
import { renderTableau } from "../../../test/synthetic/render";
import type { Card } from "../../model";
import { CARD_RASTER } from "../adapter";
import { orderQuad } from "../quad";
import type { Cv } from "./cv";
import { loadOpenCv } from "./load-node";
import { rectifyCard } from "./rectify";

let cv: Cv;
beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000);

const CARD: Card = {
  count: 1,
  color: "red",
  shape: "oval",
  fill: "solid",
};

describe("rectifyCard", () => {
  test("produces a CARD_RASTER-sized white card with centered ink", async () => {
    const { image, truth } = await renderTableau([CARD]);
    const raster = rectifyCard(cv, image, orderQuad([...truth[0].quad]));
    expect(raster.width).toBe(CARD_RASTER.width);
    expect(raster.height).toBe(CARD_RASTER.height);

    const at = (x: number, y: number) => {
      const i = (y * raster.width + x) * 4;
      return [raster.data[i], raster.data[i + 1], raster.data[i + 2]];
    };
    // corners: card-white
    const [r0, g0, b0] = at(20, 20);
    expect(Math.min(r0, g0, b0)).toBeGreaterThan(200);
    // center: red ink (solid oval)
    const [r1, g1] = at(raster.width / 2, raster.height / 2);
    expect(r1).toBeGreaterThan(140);
    expect(g1).toBeLessThan(130);
  });
});
```

Run: `npx vitest run src/vision/opencv/rectify.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/vision/opencv/rectify.ts`:

```ts
import type { Quad } from "../../model";
import { CARD_RASTER } from "../adapter";
import type { Cv } from "./cv";

export function rectifyCard(cv: Cv, frame: ImageData, quad: Quad): ImageData {
  const { width, height } = CARD_RASTER;
  const src = cv.matFromImageData(frame);
  const srcCorners = cv.matFromArray(4, 1, cv.CV_32FC2, [
    quad[0].x, quad[0].y,
    quad[1].x, quad[1].y,
    quad[2].x, quad[2].y,
    quad[3].x, quad[3].y,
  ]);
  const dstCorners = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    width, 0,
    width, height,
    0, height,
  ]);
  const transform = cv.getPerspectiveTransform(srcCorners, dstCorners);
  const dst = new cv.Mat();
  try {
    cv.warpPerspective(
      src,
      dst,
      transform,
      new cv.Size(width, height),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE,
      new cv.Scalar(),
    );
    return new ImageData(
      new Uint8ClampedArray(dst.data.slice()),
      width,
      height,
    );
  } finally {
    dst.delete();
    transform.delete();
    dstCorners.delete();
    srcCorners.delete();
    src.delete();
  }
}
```

- [ ] **Step 3: Run to verify pass**

Run: `npx vitest run src/vision/opencv/rectify.test.ts` — Expected:
1 passed.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Add perspective rectification to canonical card raster"
```

---

### Task 12: segmentSymbols

**Files:**
- Create: `src/vision/opencv/segment.ts`,
  `src/vision/opencv/segment.test.ts`

**Interfaces:**
- Consumes: `Cv`, `SymbolRegion`, `renderCardRaster`.
- Produces: `segmentSymbols(cv: Cv, card: ImageData): SymbolRegion[]` —
  **fill-invariant**: regions are traced from the ink mask's *external*
  contours only (a striped symbol's solid outline stroke encloses its
  stripes, so `RETR_EXTERNAL` sees one region per symbol regardless of
  fill), size-filtered, with convex hulls.

- [ ] **Step 1: Write failing tests — the fill-invariance matrix**

`src/vision/opencv/segment.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "vitest";
import { renderCardRaster } from "../../../test/synthetic/render";
import type { Card, Count, Fill, Shape } from "../../model";
import type { Cv } from "./cv";
import { loadOpenCv } from "./load-node";
import { segmentSymbols } from "./segment";

let cv: Cv;
beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000);

const SHAPES: Shape[] = ["diamond", "oval", "squiggle"];
const FILLS: Fill[] = ["solid", "striped", "open"];
const COUNTS: Count[] = [1, 2, 3];

describe("segmentSymbols is fill-invariant", () => {
  for (const shape of SHAPES) {
    for (const fill of FILLS) {
      for (const count of COUNTS) {
        test(`${count} ${fill} ${shape} -> ${count} region(s)`, async () => {
          const card: Card = { count, color: "purple", shape, fill };
          const raster = await renderCardRaster(card);
          const regions = segmentSymbols(cv, raster);
          expect(regions).toHaveLength(count);
          for (const region of regions) {
            expect(region.outline.length).toBeGreaterThan(7);
            expect(region.hull.length).toBeGreaterThanOrEqual(3);
          }
        });
      }
    }
  }
});
```

(27 cases — this matrix is the fill-invariance requirement from the
spec, executable.)

Run: `npx vitest run src/vision/opencv/segment.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/vision/opencv/segment.ts`:

```ts
import type { SymbolRegion } from "../adapter";
import type { Cv } from "./cv";

// a symbol must occupy a sane fraction of the raster
const MIN_SYMBOL_AREA_FRACTION = 0.01;
const MAX_SYMBOL_AREA_FRACTION = 0.35;

// ink = notably saturated OR notably dark (catches all three colors
// on the white card face)
const MIN_INK_SATURATION = 60; // 0..255
const MAX_INK_VALUE = 140; // 0..255

function matToPoints(cv: Cv, mat: Cv): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < mat.rows; i++) {
    points.push({ x: mat.data32S[i * 2], y: mat.data32S[i * 2 + 1] });
  }
  return points;
}

export function segmentSymbols(cv: Cv, card: ImageData): SymbolRegion[] {
  const src = cv.matFromImageData(card);
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  const channels = new cv.MatVector();
  const saturated = new cv.Mat();
  const dark = new cv.Mat();
  const ink = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.split(hsv, channels);
    cv.threshold(
      channels.get(1),
      saturated,
      MIN_INK_SATURATION,
      255,
      cv.THRESH_BINARY,
    );
    cv.threshold(
      channels.get(2),
      dark,
      MAX_INK_VALUE,
      255,
      cv.THRESH_BINARY_INV,
    );
    cv.bitwise_or(saturated, dark, ink);

    // EXTERNAL: a striped/open symbol's outline stroke encloses its
    // interior, so stripes never surface as separate top-level regions
    cv.findContours(
      ink,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );

    const rasterArea = card.width * card.height;
    const regions: SymbolRegion[] = [];
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      if (
        area >= rasterArea * MIN_SYMBOL_AREA_FRACTION &&
        area <= rasterArea * MAX_SYMBOL_AREA_FRACTION
      ) {
        const hull = new cv.Mat();
        cv.convexHull(contour, hull);
        regions.push({
          outline: matToPoints(cv, contour),
          hull: matToPoints(cv, hull),
        });
        hull.delete();
      }
      contour.delete();
    }
    // left-to-right for deterministic downstream behavior
    return regions.sort(
      (a, b) =>
        Math.min(...a.outline.map((p) => p.x)) -
        Math.min(...b.outline.map((p) => p.x)),
    );
  } finally {
    hierarchy.delete();
    contours.delete();
    ink.delete();
    dark.delete();
    saturated.delete();
    channels.delete();
    hsv.delete();
    rgb.delete();
    src.delete();
  }
}
```

- [ ] **Step 3: Run to verify pass**

Run: `npx vitest run src/vision/opencv/segment.test.ts`
Expected: 27 passed. If striped cases fail with count > expected, the
stripe pattern is leaking past the outline stroke — check that the
synthetic stroke is unbroken before touching thresholds.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Add fill-invariant symbol segmentation"
```

---

### Task 13: Pure region geometry (area, simplify, deviation, mask)

**Files:**
- Create: `src/vision/pipeline/regions.ts`,
  `src/vision/pipeline/regions.test.ts`

**Interfaces:**
- Consumes: `Point` from `src/model`.
- Produces (pure TS, used by all classifiers):
  - `polygonArea(points: Point[]): number` (shoelace, absolute)
  - `perimeter(points: Point[]): number` (closed)
  - `simplifyPolygon(points: Point[], epsilon: number): Point[]`
    (Douglas–Peucker, closed-polygon handling)
  - `maxHullDeviation(outline: Point[], hull: Point[]): number`
    (deepest convexity defect: max distance from outline points to the
    hull boundary)
  - `polygonMask(outline: Point[], width: number, height: number):
    Uint8Array` (even-odd scanline fill; 1 = inside)
  - `erodeMask(mask: Uint8Array, width: number, height: number,
    iterations: number): Uint8Array` (4-neighborhood)

- [ ] **Step 1: Write failing tests**

`src/vision/pipeline/regions.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { Point } from "../../model";
import {
  erodeMask,
  maxHullDeviation,
  perimeter,
  polygonArea,
  polygonMask,
  simplifyPolygon,
} from "./regions";

const square: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe("polygonArea / perimeter", () => {
  test("square", () => {
    expect(polygonArea(square)).toBe(100);
    expect(perimeter(square)).toBe(40);
  });
  test("orientation-independent", () => {
    expect(polygonArea([...square].reverse())).toBe(100);
  });
});

describe("simplifyPolygon", () => {
  test("collapses collinear points on a square boundary", () => {
    const dense: Point[] = [];
    for (let i = 0; i <= 10; i++) dense.push({ x: i, y: 0 });
    for (let i = 1; i <= 10; i++) dense.push({ x: 10, y: i });
    for (let i = 9; i >= 0; i--) dense.push({ x: i, y: 10 });
    for (let i = 9; i >= 1; i--) dense.push({ x: 0, y: i });
    expect(simplifyPolygon(dense, 0.5)).toHaveLength(4);
  });
});

describe("maxHullDeviation", () => {
  test("zero for a convex polygon", () => {
    expect(maxHullDeviation(square, square)).toBeCloseTo(0);
  });
  test("measures a notch depth", () => {
    // square with a notch reaching the center
    const notched: Point[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 5, y: 5 }, // notch tip, 5 below the top edge
      { x: 6, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(maxHullDeviation(notched, square)).toBeCloseTo(5);
  });
});

describe("polygonMask / erodeMask", () => {
  test("fills the interior, erosion shrinks it", () => {
    const mask = polygonMask(square, 12, 12);
    const count = mask.reduce((s: number, v) => s + v, 0);
    // center-sampling: pixel (x,y) filled iff center (x+.5,y+.5)
    // is inside the polygon — exactly 0..9 x 0..9 for this square
    expect(count).toBe(100);
    expect(mask[6 * 12 + 5]).toBe(1); // center inside
    expect(mask[0]).toBe(1); // (0,0): center (0.5,0.5) inside
    expect(mask[10 * 12 + 10]).toBe(0); // (10,10): center outside
    const eroded = erodeMask(mask, 12, 12, 2);
    const erodedCount = eroded.reduce((s: number, v) => s + v, 0);
    expect(erodedCount).toBeLessThan(count);
    expect(eroded[6 * 12 + 5]).toBe(1); // center survives
  });
});
```

Run: `npx vitest run src/vision/pipeline/regions.test.ts` — Expected:
FAIL.

- [ ] **Step 2: Implement**

`src/vision/pipeline/regions.ts`:

```ts
import type { Point } from "../../model";

export function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function perimeter(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

function pointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq
    ? Math.max(
        0,
        Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq),
      )
    : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function douglasPeucker(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;
  const a = points[0];
  const b = points[points.length - 1];
  let maxDistance = -1;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToSegment(points[i], a, b);
    if (d > maxDistance) {
      maxDistance = d;
      index = i;
    }
  }
  if (maxDistance <= epsilon) return [a, b];
  const left = douglasPeucker(points.slice(0, index + 1), epsilon);
  const right = douglasPeucker(points.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

// closed-polygon Douglas-Peucker: anchor at the two mutually farthest
// points, simplify each chain, and rejoin
export function simplifyPolygon(points: Point[], epsilon: number): Point[] {
  if (points.length <= 4) return points;
  let ai = 0;
  let bi = 1;
  let far = -1;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(
        points[j].x - points[i].x,
        points[j].y - points[i].y,
      );
      if (d > far) {
        far = d;
        ai = i;
        bi = j;
      }
    }
  }
  const chain1 = points.slice(ai, bi + 1);
  const chain2 = [...points.slice(bi), ...points.slice(0, ai + 1)];
  const s1 = douglasPeucker(chain1, epsilon);
  const s2 = douglasPeucker(chain2, epsilon);
  return [...s1.slice(0, -1), ...s2.slice(0, -1)];
}

export function maxHullDeviation(outline: Point[], hull: Point[]): number {
  let max = 0;
  for (const p of outline) {
    let nearest = Infinity;
    for (let i = 0; i < hull.length; i++) {
      nearest = Math.min(
        nearest,
        pointToSegment(p, hull[i], hull[(i + 1) % hull.length]),
      );
    }
    max = Math.max(max, nearest);
  }
  return max;
}

export function polygonMask(
  outline: Point[],
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const xs: number[] = [];
    const scanY = y + 0.5;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      if (a.y <= scanY === b.y <= scanY) continue;
      xs.push(a.x + ((scanY - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = from; x <= to; x++) mask[y * width + x] = 1;
    }
  }
  return mask;
}

export function erodeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  iterations: number,
): Uint8Array {
  let current = mask;
  for (let n = 0; n < iterations; n++) {
    const next = new Uint8Array(width * height);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        next[i] =
          current[i] &
          current[i - 1] &
          current[i + 1] &
          current[i - width] &
          current[i + width];
      }
    }
    current = next;
  }
  return current;
}
```

- [ ] **Step 3: Run to verify pass; commit**

Run: `npx vitest run src/vision/pipeline/regions.test.ts`
Expected: 7 passed.

```bash
git add -A && git commit -m "Add pure polygon geometry helpers for classification"
```

---

### Task 14: Pixel statistics + color classifier (with white balance)

**Files:**
- Create: `src/vision/pipeline/classify/pixels.ts`,
  `src/vision/pipeline/classify/color.ts`,
  `src/vision/pipeline/classify/color.test.ts`

**Interfaces:**
- Consumes: `SymbolRegion`, `polygonMask` (Task 13), and in tests:
  `renderCardRaster`, `segmentSymbols`, `loadOpenCv`.
- Produces:
  - `pixels.ts`: `whiteBalance(raster: ImageData): [number, number,
    number]` (per-channel gain from the card's border ring),
    `rgbAt(raster, index, gains): [number, number, number]`,
    `saturationOf(r, g, b): number` (0..1),
    `hueOf(r, g, b): number` (degrees 0..360),
    `regionMasks(raster, regions): Uint8Array` (union of all symbol
    outlines' polygon masks)
  - `color.ts`: `classifyColor(raster: ImageData, regions:
    SymbolRegion[]): { value: Color; confidence: number }`
- Calibration note: hue prototypes and margins are **named constants
  tuned against fixtures** — synthetic now, real photos later (Task
  19's confusion matrix is where re-tuning happens; spec requires the
  warm-light purple/red case there).

- [ ] **Step 1: Write failing tests**

`src/vision/pipeline/classify/color.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "vitest";
import { renderCardRaster } from "../../../../test/synthetic/render";
import type { Card, Color } from "../../../model";
import type { Cv } from "../../opencv/cv";
import { loadOpenCv } from "../../opencv/load-node";
import { segmentSymbols } from "../../opencv/segment";
import { classifyColor } from "./color";

let cv: Cv;
beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000);

const COLORS: Color[] = ["red", "green", "purple"];

describe("classifyColor", () => {
  for (const color of COLORS) {
    for (const fill of ["solid", "striped", "open"] as const) {
      test(`${color} ${fill}`, async () => {
        const card: Card = { count: 2, color, shape: "oval", fill };
        const raster = await renderCardRaster(card);
        const result = classifyColor(raster, segmentSymbols(cv, raster));
        expect(result.value).toBe(color);
        expect(result.confidence).toBeGreaterThan(0.3);
      });
    }
  }
});
```

Run: `npx vitest run src/vision/pipeline/classify` — Expected: FAIL.

- [ ] **Step 2: Implement pixel helpers**

`src/vision/pipeline/classify/pixels.ts`:

```ts
import type { SymbolRegion } from "../../adapter";
import { polygonMask } from "../regions";

// fraction of the raster edge treated as known-white card border
const BORDER_RING = 0.05;

// Per-channel gains that would make the card's own border neutral.
// Every Set card carries this white reference; using it makes hue
// stable under warm/cool light (spec: white-balance before color).
export function whiteBalance(raster: ImageData): [number, number, number] {
  const { data, width, height } = raster;
  const rx = Math.max(2, Math.round(width * BORDER_RING));
  const ry = Math.max(2, Math.round(height * BORDER_RING));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < height; y++) {
    const inBorderRow = y < ry || y >= height - ry;
    for (let x = 0; x < width; x++) {
      if (!inBorderRow && x >= rx && x < width - rx) continue;
      const i = (y * width + x) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  r /= n;
  g /= n;
  b /= n;
  const luma = (r + g + b) / 3;
  return [luma / (r || 1), luma / (g || 1), luma / (b || 1)];
}

export function rgbAt(
  raster: ImageData,
  pixelIndex: number,
  gains: [number, number, number],
): [number, number, number] {
  const i = pixelIndex * 4;
  return [
    Math.min(255, raster.data[i] * gains[0]),
    Math.min(255, raster.data[i + 1] * gains[1]),
    Math.min(255, raster.data[i + 2] * gains[2]),
  ];
}

export function saturationOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

export function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  return ((hue * 60) + 360) % 360;
}

// union mask of all symbol regions at raster resolution
export function regionMasks(
  raster: ImageData,
  regions: SymbolRegion[],
): Uint8Array {
  const union = new Uint8Array(raster.width * raster.height);
  for (const region of regions) {
    const mask = polygonMask(region.outline, raster.width, raster.height);
    for (let i = 0; i < union.length; i++) union[i] |= mask[i];
  }
  return union;
}
```

- [ ] **Step 3: Implement the color classifier**

`src/vision/pipeline/classify/color.ts`:

```ts
import type { Color } from "../../../model";
import type { SymbolRegion } from "../../adapter";
import {
  hueOf,
  regionMasks,
  rgbAt,
  saturationOf,
  whiteBalance,
} from "./pixels";

// hue prototypes (degrees) — tuned against fixtures
const PROTOTYPES: Record<Color, number> = {
  red: 5,
  green: 130,
  purple: 290,
};

// pixels below this saturation are card-white/anti-aliasing, not ink
const MIN_INK_SATURATION = 0.25;

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function classifyColor(
  raster: ImageData,
  regions: SymbolRegion[],
): { value: Color; confidence: number } {
  const gains = whiteBalance(raster);
  const mask = regionMasks(raster, regions);
  let x = 0;
  let y = 0; // mean hue as a vector (circular mean)
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const [r, g, b] = rgbAt(raster, i, gains);
    if (saturationOf(r, g, b) < MIN_INK_SATURATION) continue;
    const radians = (hueOf(r, g, b) * Math.PI) / 180;
    x += Math.cos(radians);
    y += Math.sin(radians);
    n++;
  }
  if (n === 0) return { value: "red", confidence: 0 };
  const meanHue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

  const distances = (Object.keys(PROTOTYPES) as Color[])
    .map((color) => ({
      color,
      d: hueDistance(meanHue, PROTOTYPES[color]),
    }))
    .sort((a, b) => a.d - b.d);
  const [best, runnerUp] = distances;
  // margin-based confidence, 0 when tied, ->1 as the winner dominates
  const confidence =
    (runnerUp.d - best.d) / Math.max(runnerUp.d + best.d, 1);
  return { value: best.color, confidence };
}
```

- [ ] **Step 4: Run to verify pass; commit**

Run: `npx vitest run src/vision/pipeline/classify`
Expected: 9 passed.

```bash
git add -A && git commit -m "Add white-balanced color classifier"
```

---

### Task 15: Count classifier

**Files:**
- Create: `src/vision/pipeline/classify/count.ts`,
  `src/vision/pipeline/classify/count.test.ts`

**Interfaces:**
- Consumes: `Count` (`src/model`), `SymbolRegion`, `polygonArea`.
- Produces: `classifyCount(regions: SymbolRegion[]): { value: Count;
  confidence: number }` — count confidence is NOT a winner/runner-up
  margin (it's a tally, per spec): it reflects region-size consistency
  and staying inside the 1..3 domain.

- [ ] **Step 1: Write failing tests**

`src/vision/pipeline/classify/count.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "vitest";
import { renderCardRaster } from "../../../../test/synthetic/render";
import type { Card, Count, Fill } from "../../../model";
import type { Cv } from "../../opencv/cv";
import { loadOpenCv } from "../../opencv/load-node";
import { segmentSymbols } from "../../opencv/segment";
import { classifyCount } from "./count";

let cv: Cv;
beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000);

describe("classifyCount", () => {
  for (const count of [1, 2, 3] as Count[]) {
    for (const fill of ["solid", "striped", "open"] as Fill[]) {
      test(`${count} ${fill} symbols`, async () => {
        const card: Card = { count, color: "green", shape: "diamond", fill };
        const raster = await renderCardRaster(card);
        const result = classifyCount(segmentSymbols(cv, raster));
        expect(result.value).toBe(count);
        expect(result.confidence).toBeGreaterThan(0.5);
      });
    }
  }

  test("degrades confidence gracefully outside 1..3", () => {
    const result = classifyCount([]);
    expect(result.value).toBe(1);
    expect(result.confidence).toBe(0);
  });
});
```

Run: `npx vitest run src/vision/pipeline/classify/count.test.ts` —
Expected: FAIL.

- [ ] **Step 2: Implement**

`src/vision/pipeline/classify/count.ts`:

```ts
import type { Count } from "../../../model";
import type { SymbolRegion } from "../../adapter";
import { polygonArea } from "../regions";

// symbols on one card are the same size; regions far from the median
// area are debris (glare blobs, specks), not symbols
const AREA_CONSISTENCY = { min: 0.55, max: 1.8 };

export function classifyCount(regions: SymbolRegion[]): {
  value: Count;
  confidence: number;
} {
  if (regions.length === 0) return { value: 1, confidence: 0 };

  const areas = regions.map((r) => polygonArea(r.outline));
  const median = [...areas].sort((a, b) => a - b)[
    Math.floor(areas.length / 2)
  ];
  const plausible = areas.filter(
    (a) =>
      a >= median * AREA_CONSISTENCY.min && a <= median * AREA_CONSISTENCY.max,
  );
  const rejected = regions.length - plausible.length;

  const clamped = Math.min(3, Math.max(1, plausible.length)) as Count;
  if (plausible.length < 1 || plausible.length > 3) {
    return { value: clamped, confidence: 0.2 };
  }
  // consistency: how tightly the plausible areas cluster
  const spread =
    (Math.max(...plausible) - Math.min(...plausible)) / (median || 1);
  const consistency = Math.max(0, 1 - spread);
  const penalty = rejected > 0 ? 0.3 : 0;
  return {
    value: clamped,
    confidence: Math.max(0.2, consistency - penalty),
  };
}
```

- [ ] **Step 3: Run to verify pass; commit**

Run: `npx vitest run src/vision/pipeline/classify/count.test.ts`
Expected: 10 passed.

```bash
git add -A && git commit -m "Add tally-based count classifier"
```

---

### Task 16: Shape classifier

**Files:**
- Create: `src/vision/pipeline/classify/shape.ts`,
  `src/vision/pipeline/classify/shape.test.ts`

**Interfaces:**
- Consumes: `Shape` (`src/model`), `SymbolRegion`, `polygonArea`,
  `perimeter`, `simplifyPolygon`, `maxHullDeviation` (Task 13).
- Produces: `classifyShape(regions: SymbolRegion[]): { value: Shape;
  confidence: number }` — a feature vote per spec: diamond via DP
  vertex count ≈ 4; squiggle via convexity-defect depth *combined
  with* low solidity (solidity alone is too weak); oval as the smooth
  convex residual. Classifies the largest region (most reliable), all
  features rotation-invariant (the 180° rectification ambiguity is
  harmless by design).

- [ ] **Step 1: Write failing tests**

`src/vision/pipeline/classify/shape.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "vitest";
import { renderCardRaster } from "../../../../test/synthetic/render";
import type { Card, Fill, Shape } from "../../../model";
import type { Cv } from "../../opencv/cv";
import { loadOpenCv } from "../../opencv/load-node";
import { segmentSymbols } from "../../opencv/segment";
import { classifyShape } from "./shape";

let cv: Cv;
beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000);

describe("classifyShape", () => {
  for (const shape of ["diamond", "oval", "squiggle"] as Shape[]) {
    for (const fill of ["solid", "striped", "open"] as Fill[]) {
      test(`${shape} (${fill})`, async () => {
        const card: Card = { count: 2, color: "red", shape, fill };
        const raster = await renderCardRaster(card);
        const result = classifyShape(segmentSymbols(cv, raster));
        expect(result.value).toBe(shape);
        expect(result.confidence).toBeGreaterThan(0.3);
      });
    }
  }

  test("returns zero confidence with no regions", () => {
    expect(classifyShape([]).confidence).toBe(0);
  });
});
```

Run: `npx vitest run src/vision/pipeline/classify/shape.test.ts` —
Expected: FAIL.

- [ ] **Step 2: Implement**

`src/vision/pipeline/classify/shape.ts`:

```ts
import type { Shape } from "../../../model";
import type { SymbolRegion } from "../../adapter";
import {
  maxHullDeviation,
  perimeter,
  polygonArea,
  simplifyPolygon,
} from "../regions";

// DP epsilon as a fraction of perimeter (spec: epsilon specified this
// way so it scales with symbol size)
const SIMPLIFY_EPSILON_FRACTION = 0.03;
// a squiggle's solidity sits ~0.90-0.95 vs an oval's ~0.97-0.99;
// defect depth (relative to sqrt(area)) is the stronger signal
const SQUIGGLE_SOLIDITY = 0.955;
const SQUIGGLE_DEFECT_RATIO = 0.05;

export function classifyShape(regions: SymbolRegion[]): {
  value: Shape;
  confidence: number;
} {
  if (regions.length === 0) return { value: "oval", confidence: 0 };
  const region = regions.reduce((a, b) =>
    polygonArea(a.outline) >= polygonArea(b.outline) ? a : b,
  );

  const outlineArea = polygonArea(region.outline);
  const hullArea = polygonArea(region.hull);
  const solidity = hullArea > 0 ? outlineArea / hullArea : 1;
  const defectRatio =
    maxHullDeviation(region.outline, region.hull) /
    Math.max(Math.sqrt(outlineArea), 1);

  const epsilon = SIMPLIFY_EPSILON_FRACTION * perimeter(region.outline);
  const vertices = simplifyPolygon(region.outline, epsilon).length;

  // feature vote
  if (vertices === 4 && solidity > 0.9) {
    // polygonal and convex-ish: diamond. Confidence from how far
    // solidity sits above the squiggle band.
    return {
      value: "diamond",
      confidence: Math.min(1, (solidity - SQUIGGLE_SOLIDITY) * 12 + 0.5),
    };
  }
  const squiggleVotes =
    Number(solidity < SQUIGGLE_SOLIDITY) +
    Number(defectRatio > SQUIGGLE_DEFECT_RATIO);
  if (squiggleVotes === 2) {
    return {
      value: "squiggle",
      confidence: Math.min(
        1,
        (SQUIGGLE_SOLIDITY - solidity) * 10 +
          (defectRatio - SQUIGGLE_DEFECT_RATIO) * 5 +
          0.4,
      ),
    };
  }
  if (squiggleVotes === 1) {
    // features disagree: pick by the stronger deviation, low confidence
    const value: Shape =
      defectRatio > SQUIGGLE_DEFECT_RATIO ? "squiggle" : "oval";
    return { value, confidence: 0.3 };
  }
  return {
    value: "oval",
    confidence: Math.min(1, (solidity - SQUIGGLE_SOLIDITY) * 15 + 0.4),
  };
}
```

- [ ] **Step 3: Run to verify pass; commit**

Run: `npx vitest run src/vision/pipeline/classify/shape.test.ts`
Expected: 10 passed. Tuning knobs if synthetic squiggles land wrong:
`SQUIGGLE_SOLIDITY` first, then `SQUIGGLE_DEFECT_RATIO`.

```bash
git add -A && git commit -m "Add feature-vote shape classifier"
```

---

### Task 17: Fill classifier

**Files:**
- Create: `src/vision/pipeline/classify/fill.ts`,
  `src/vision/pipeline/classify/fill.test.ts`

**Interfaces:**
- Consumes: `Fill` (`src/model`), `SymbolRegion`, `polygonMask`,
  `erodeMask` (Task 13), pixel helpers (Task 14).
- Produces: `classifyFill(raster: ImageData, regions: SymbolRegion[]):
  { value: Fill; confidence: number }` — measures *interior* pixels
  (mask eroded past the outline stroke): ink fraction separates
  solid/open; row-transition frequency confirms striped (this is what
  the 600×384 raster budget exists for).

- [ ] **Step 1: Write failing tests**

`src/vision/pipeline/classify/fill.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "vitest";
import { renderCardRaster } from "../../../../test/synthetic/render";
import type { Card, Color, Fill } from "../../../model";
import type { Cv } from "../../opencv/cv";
import { loadOpenCv } from "../../opencv/load-node";
import { segmentSymbols } from "../../opencv/segment";
import { classifyFill } from "./fill";

let cv: Cv;
beforeAll(async () => {
  cv = await loadOpenCv();
}, 30_000);

describe("classifyFill", () => {
  for (const fill of ["solid", "striped", "open"] as Fill[]) {
    for (const color of ["red", "green", "purple"] as Color[]) {
      test(`${fill} ${color}`, async () => {
        const card: Card = { count: 1, color, shape: "oval", fill };
        const raster = await renderCardRaster(card);
        const result = classifyFill(raster, segmentSymbols(cv, raster));
        expect(result.value).toBe(fill);
        expect(result.confidence).toBeGreaterThan(0.3);
      });
    }
  }

  test("returns zero confidence with no regions", async () => {
    const raster = await renderCardRaster({
      count: 1,
      color: "red",
      shape: "oval",
      fill: "solid",
    });
    expect(classifyFill(raster, []).confidence).toBe(0);
  });
});
```

Run: `npx vitest run src/vision/pipeline/classify/fill.test.ts` —
Expected: FAIL.

- [ ] **Step 2: Implement**

`src/vision/pipeline/classify/fill.ts`:

```ts
import type { Fill } from "../../../model";
import type { SymbolRegion } from "../../adapter";
import { erodeMask, polygonArea, polygonMask } from "../regions";
import { rgbAt, saturationOf, whiteBalance } from "./pixels";

// erosion iterations to get past the outline stroke + anti-aliasing
const STROKE_EROSION = 8;
const MIN_INK_SATURATION = 0.25;
// ink-fraction decision bands (tuned against fixtures)
const SOLID_MIN = 0.75;
const OPEN_MAX = 0.15;
// striped confirmation: mean saturated<->white transitions per row
const STRIPED_MIN_TRANSITIONS = 2;

export function classifyFill(
  raster: ImageData,
  regions: SymbolRegion[],
): { value: Fill; confidence: number } {
  if (regions.length === 0) return { value: "open", confidence: 0 };
  const region = regions.reduce((a, b) =>
    polygonArea(a.outline) >= polygonArea(b.outline) ? a : b,
  );
  const { width, height } = raster;
  const interior = erodeMask(
    polygonMask(region.outline, width, height),
    width,
    height,
    STROKE_EROSION,
  );
  const gains = whiteBalance(raster);

  let inked = 0;
  let total = 0;
  let transitions = 0;
  let rows = 0;
  for (let y = 0; y < height; y++) {
    let previous: boolean | undefined;
    let rowHasInterior = false;
    let rowTransitions = 0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!interior[i]) continue;
      rowHasInterior = true;
      const [r, g, b] = rgbAt(raster, i, gains);
      const isInk = saturationOf(r, g, b) >= MIN_INK_SATURATION;
      total++;
      if (isInk) inked++;
      if (previous !== undefined && isInk !== previous) rowTransitions++;
      previous = isInk;
    }
    if (rowHasInterior) {
      rows++;
      transitions += rowTransitions;
    }
  }
  if (total === 0) return { value: "open", confidence: 0 };

  const inkFraction = inked / total;
  const meanTransitions = rows ? transitions / rows : 0;

  if (inkFraction >= SOLID_MIN) {
    return {
      value: "solid",
      confidence: Math.min(1, (inkFraction - SOLID_MIN) * 3 + 0.4),
    };
  }
  if (inkFraction <= OPEN_MAX) {
    return {
      value: "open",
      confidence: Math.min(1, (OPEN_MAX - inkFraction) * 4 + 0.4),
    };
  }
  // mid ink-fraction: striped iff the interior actually alternates
  if (meanTransitions >= STRIPED_MIN_TRANSITIONS) {
    return {
      value: "striped",
      confidence: Math.min(1, meanTransitions / 8 + 0.3),
    };
  }
  // ambiguous: mid fraction but no alternation — lean by proximity
  const value: Fill =
    inkFraction > (SOLID_MIN + OPEN_MAX) / 2 ? "solid" : "open";
  return { value, confidence: 0.2 };
}
```

- [ ] **Step 3: Run to verify pass; commit**

Run: `npx vitest run src/vision/pipeline/classify/fill.test.ts`
Expected: 10 passed. Tuning order if striped fails: check
`STROKE_EROSION` erased the stripes (too high) before touching the
bands.

```bash
git add -A && git commit -m "Add interior-statistics fill classifier"
```

---

### Task 18: classify assembly, CardVision factory, analyze()

**Files:**
- Create: `src/vision/pipeline/classify/index.ts`,
  `src/vision/opencv/index.ts`, `src/vision/pipeline/analyze.ts`,
  `src/vision/pipeline/analyze.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces (Plan B's worker consumes exactly these):
  - `classifyCard(raster: ImageData, regions: SymbolRegion[]):
    { card: Card; confidence: AttributeConfidence }`
  - `createCardVision(cv: Cv): CardVision`
  - `analyze(vision: CardVision, frame: ImageData, options?:
    DetectOptions): { cards: DetectedCard[]; timings:
    Record<string, number> }` — CardIds minted sequentially here (spec);
    the worker handler stamps `frameId`/`frameSize` into the full
    `FrameAnalysis`.

- [ ] **Step 1: Write failing end-to-end test**

`src/vision/pipeline/analyze.test.ts`:

```ts
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
```

Run: `npx vitest run src/vision/pipeline/analyze.test.ts` — Expected:
FAIL.

- [ ] **Step 2: Implement the three assembly modules**

`src/vision/pipeline/classify/index.ts`:

```ts
import type { AttributeConfidence, Card } from "../../../model";
import type { SymbolRegion } from "../../adapter";
import { classifyColor } from "./color";
import { classifyCount } from "./count";
import { classifyFill } from "./fill";
import { classifyShape } from "./shape";

export function classifyCard(
  raster: ImageData,
  regions: SymbolRegion[],
): { card: Card; confidence: AttributeConfidence } {
  const count = classifyCount(regions);
  const color = classifyColor(raster, regions);
  const shape = classifyShape(regions);
  const fill = classifyFill(raster, regions);
  return {
    card: {
      count: count.value,
      color: color.value,
      shape: shape.value,
      fill: fill.value,
    },
    confidence: {
      count: count.confidence,
      color: color.confidence,
      shape: shape.confidence,
      fill: fill.confidence,
    },
  };
}
```

`src/vision/opencv/index.ts`:

```ts
import type { CardVision } from "../adapter";
import type { Cv } from "./cv";
import { detectCards } from "./detect";
import { rectifyCard } from "./rectify";
import { segmentSymbols } from "./segment";

export function createCardVision(cv: Cv): CardVision {
  return {
    detectCards: (frame, options) => detectCards(cv, frame, options),
    rectifyCard: (frame, quad) => rectifyCard(cv, frame, quad),
    segmentSymbols: (card) => segmentSymbols(cv, card),
  };
}
```

`src/vision/pipeline/analyze.ts`:

```ts
import type { DetectedCard } from "../../model";
import { cardId } from "../../model";
import type { CardVision, DetectOptions } from "../adapter";
import { classifyCard } from "./classify";

export interface AnalyzeOutput {
  cards: DetectedCard[];
  timings: Record<string, number>;
}

// The full still-frame pipeline. CardIds are minted here, sequential
// and frame-local (spec). The worker handler wraps this into a
// FrameAnalysis by stamping frameId and frameSize.
export function analyze(
  vision: CardVision,
  frame: ImageData,
  options?: DetectOptions,
): AnalyzeOutput {
  const timings: Record<string, number> = {
    detect: 0,
    rectify: 0,
    segment: 0,
    classify: 0,
  };
  const t0 = performance.now();
  const quads = vision.detectCards(frame, options);
  timings.detect = performance.now() - t0;

  const cards: DetectedCard[] = quads.map((quad, index) => {
    const t1 = performance.now();
    const raster = vision.rectifyCard(frame, quad);
    const t2 = performance.now();
    const regions = vision.segmentSymbols(raster);
    const t3 = performance.now();
    const { card, confidence } = classifyCard(raster, regions);
    const t4 = performance.now();
    timings.rectify += t2 - t1;
    timings.segment += t3 - t2;
    timings.classify += t4 - t3;
    return { id: cardId(index), quad, card, confidence };
  });
  return { cards, timings };
}
```

- [ ] **Step 3: Run to verify pass**

Run: `npx vitest run src/vision/pipeline/analyze.test.ts`
Expected: 1 passed. Then run the whole suite:
`npm test` — Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Assemble classify, CardVision factory, and analyze pipeline"
```

---

### Task 19: Real-photo fixture harness + confusion matrix

**Files:**
- Create: `test/fixtures.ts`, `test/confusion.ts`,
  `test/confusion.test.ts`, `test/real-photos.test.ts`,
  `test/fixtures/tuning/README.md`, `test/fixtures/holdout/README.md`

**Interfaces:**
- Consumes: the full pipeline (Task 18), sharp.
- Produces:
  - Fixture format: `<name>.jpg|.png` + `<name>.json` sidecar:
    `{ "cards": [{ "key": "<CardKey>", "near": { "x": n, "y": n } }] }`
    (`near` = approximate card center in image pixels; labels are
    display-oriented, matching what capture normalization will produce)
  - `loadFixtures(dir: "tuning" | "holdout"): Promise<Fixture[]>` where
    `Fixture = { name: string; image: ImageData; cards:
    { key: CardKey; near: Point }[] }`
  - `confusionMatrix(pairs: { expected: string; actual: string }[]):
    Record<string, Record<string, number>>` + `formatConfusion(...)`
  - A vitest suite that runs every fixture through `analyze` and
    reports per-attribute confusion — skipped while the directories
    are empty, hard-failing in CI once photos land
- **User workstream (photography, not code):** populate the fixture
  dirs per the spec's coverage matrix — all fills incl. striped at
  small scale; purple AND red under warm light; white cards on a light
  table; touching cards; strong perspective; shadowed frames;
  EXIF-oriented portrait shots. Rule: `tuning/` may inform constant
  tweaks; `holdout/` must never (spec's overfitting guard). Both
  READMEs state this.

- [ ] **Step 1: Write the confusion-matrix unit test**

`test/confusion.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { confusionMatrix, formatConfusion } from "./confusion";

describe("confusionMatrix", () => {
  test("tallies expected vs actual", () => {
    const m = confusionMatrix([
      { expected: "red", actual: "red" },
      { expected: "red", actual: "purple" },
      { expected: "green", actual: "green" },
    ]);
    expect(m.red.red).toBe(1);
    expect(m.red.purple).toBe(1);
    expect(m.green.green).toBe(1);
    expect(formatConfusion(m)).toContain("red");
  });
});
```

Run: `npx vitest run test/confusion.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement confusion + fixture loading**

`test/confusion.ts`:

```ts
export type Confusion = Record<string, Record<string, number>>;

export function confusionMatrix(
  pairs: { expected: string; actual: string }[],
): Confusion {
  const matrix: Confusion = {};
  for (const { expected, actual } of pairs) {
    matrix[expected] ??= {};
    matrix[expected][actual] = (matrix[expected][actual] ?? 0) + 1;
  }
  return matrix;
}

export function formatConfusion(matrix: Confusion): string {
  const lines: string[] = [];
  for (const [expected, row] of Object.entries(matrix)) {
    const cells = Object.entries(row)
      .map(([actual, n]) => `${actual}:${n}`)
      .join(" ");
    lines.push(`  expected ${expected} -> ${cells}`);
  }
  return lines.join("\n");
}
```

`test/fixtures.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { CardKey, Point } from "../src/model";

export interface Fixture {
  name: string;
  image: ImageData;
  cards: { key: CardKey; near: Point }[];
}

const ROOT = join(import.meta.dirname, "fixtures");

export async function loadFixtures(
  dir: "tuning" | "holdout",
): Promise<Fixture[]> {
  let entries: string[];
  try {
    entries = await readdir(join(ROOT, dir));
  } catch {
    return [];
  }
  const names = entries
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .map((f) => f.replace(/\.(jpe?g|png)$/i, ""));
  const fixtures: Fixture[] = [];
  for (const name of names) {
    const file = entries.find((f) => f.startsWith(`${name}.`))!;
    const { data, info } = await sharp(join(ROOT, dir, file))
      .rotate() // apply EXIF orientation: labels are display-oriented
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const labels = JSON.parse(
      await readFile(join(ROOT, dir, `${name}.json`), "utf8"),
    );
    fixtures.push({
      name,
      image: new ImageData(
        new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
        info.width,
        info.height,
      ),
      cards: labels.cards,
    });
  }
  return fixtures;
}
```

`test/fixtures/tuning/README.md`:

```markdown
# Tuning fixtures

Real photos + `<name>.json` labels
(`{ "cards": [{ "key": "2-red-oval-striped", "near": {"x": 0, "y": 0} }] }`).
Heuristic constants MAY be tuned against these. Coverage matrix lives
in the design spec (Testing ring 2): striped-at-small-scale, warm-light
purple and red, light table, touching cards, perspective, shadows,
EXIF-portrait shots.
```

`test/fixtures/holdout/README.md`:

```markdown
# Holdout fixtures

Same format as tuning/. NEVER tune constants against these — they gate
deploy. If a holdout photo fails, add a *similar* photo to tuning/,
fix against that, and only then re-run holdout.
```

- [ ] **Step 3: Write the real-photo suite**

`test/real-photos.test.ts` — attribute-by-attribute comparison so the
confusion matrix names the failing *attribute*; `expect.soft` so one
misread card doesn't hide the rest of the frame's results:

```ts
import { beforeAll, describe, expect, test } from "vitest";
import { cardFromKey, cardKey } from "../src/model";
import type { CardVision } from "../src/vision/adapter";
import { createCardVision } from "../src/vision/opencv";
import { loadOpenCv } from "../src/vision/opencv/load-node";
import { analyze } from "../src/vision/pipeline/analyze";
import { confusionMatrix, formatConfusion } from "./confusion";
import { loadFixtures } from "./fixtures";

const ATTRIBUTES = ["count", "color", "shape", "fill"] as const;

for (const dir of ["tuning", "holdout"] as const) {
  const fixtures = await loadFixtures(dir);
  describe.skipIf(fixtures.length === 0)(`real photos: ${dir}`, () => {
    let vision: CardVision;
    beforeAll(async () => {
      vision = createCardVision(await loadOpenCv());
    }, 30_000);

    for (const fixture of fixtures) {
      test(fixture.name, () => {
        const { cards } = analyze(vision, fixture.image);
        expect(cards).toHaveLength(fixture.cards.length);

        const pairs = {
          count: [],
          color: [],
          shape: [],
          fill: [],
        } as Record<string, { expected: string; actual: string }[]>;

        for (const label of fixture.cards) {
          const nearest = cards.reduce((a, b) => {
            const at = (q: typeof a.quad) => ({
              x: (q[0].x + q[2].x) / 2,
              y: (q[0].y + q[2].y) / 2,
            });
            const da = Math.hypot(
              at(a.quad).x - label.near.x,
              at(a.quad).y - label.near.y,
            );
            const db = Math.hypot(
              at(b.quad).x - label.near.x,
              at(b.quad).y - label.near.y,
            );
            return da <= db ? a : b;
          });
          const labelCard = cardFromKey(label.key);
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
      }, 30_000);
    }
  });
}
```

- [ ] **Step 4: Run and commit**

Run: `npm test` — Expected: all suites green; both real-photo suites
reported as skipped (directories empty).

```bash
git add -A && git commit -m "Add real-photo fixture harness with confusion reporting"
```

---

## Plan A completion criteria

- `npm test` green: domain (ring 1), synthetic vision pipeline +
  OpenCV adapter (ring 2 machinery), fixture harness skipping cleanly.
- `npm run build` green; CI running both on push.
- Ready for Plan B (worker + app + UI), which consumes:
  `createCardVision`, `loadOpenCv` (Node) / a browser loader it adds,
  `analyze`, `classifyCard`, the model types, `findSets`/`makeTableau`,
  and the vendored `public/vendor/opencv-4.13.0.js`.
- Open workstream (human, parallel): photograph real Set cards per the
  coverage matrix into `test/fixtures/{tuning,holdout}/`; expect
  constant re-tuning when the first real photos land — that is the
  system working as designed, not a regression.

