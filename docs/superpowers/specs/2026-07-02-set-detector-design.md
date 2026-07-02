# Set Detector — Design

2026-07-02

A progressive web app that photographs a table of Set cards and identifies
whether a valid set is present, highlighting the cards that form it.
Everything runs in the browser; no backend.

## Scope

**v1:** still-image analysis. The user captures a photo (in-app camera
viewfinder with shutter, or native file/photo picker), the app detects and
reads every card, finds all valid sets, and renders highlights over the
photo.

**Designed-for, not built:** live video mode with real-time highlighting.
v1 interfaces are shaped so live mode is an extension, not a rework. The
specific accommodations are called out inline and summarized at the end.

## Decisions

- Classical computer vision via OpenCV.js, behind a task-level adapter
  interface. No ML, no training data. Heuristics tuned against fixture
  photos.
- React + Vite + TypeScript single-page app.
- Vision pipeline runs in a web worker; set-solving and rendering on the
  main thread.
- Installable, offline-capable PWA (service worker precaches everything,
  including OpenCV WASM). Deployed to GitHub Pages.
- All data crossing any boundary (worker/main, pipeline/UI, fixtures) is
  plain structured-clone-safe data: no classes, no library types.

## Domain model (`src/model/`)

Zero-dependency module; everything imports it, it imports nothing.

```ts
type Count = 1 | 2 | 3;
type Color = "red" | "green" | "purple";
type Shape = "diamond" | "oval" | "squiggle";
type Fill  = "solid" | "striped" | "open";

interface Card {
  count: Count;
  color: Color;
  shape: Shape;
  fill:  Fill;
}
```

Attribute types are plain literal unions (no runtime enum constants; an
`allCards(): Card[]` helper covers enumeration needs internally).

### Identity

Two distinct identities, both branded types:

```ts
// identity of a card FACE — canonical, human-readable
type CardKey = string & { readonly __brand: "CardKey" };
function cardKey(card: Card): CardKey;        // "2-red-oval-striped"
function cardFromKey(key: CardKey): Card;

// identity of one DETECTION within a frame
type CardId = number & { readonly __brand: "CardId" };
```

`CardKey` answers "which of the 81 cards is this?" — used for membership
lookup, fixtures, and debug output. `CardId` answers "which physical
detection is this?" — unique within a frame; reserved to become stable
across frames when live-mode tracking exists. Numeric base-3 card indexing
is a private implementation detail if an implementation wants it; it is
not public API.

### Geometry and analysis results

All geometry is in source-frame pixel coordinates, always.

```ts
interface Point { x: number; y: number }
type Quad = [Point, Point, Point, Point];  // clockwise from top-left
                                           // of the rectified card

interface AttributeConfidence {
  count: number; color: number; shape: number; fill: number;  // 0..1
}

interface DetectedCard {
  id: CardId;
  quad: Quad;
  card: Card;
  confidence: AttributeConfidence;
}

type FrameId = number & { readonly __brand: "FrameId" };

// the unit of pipeline input; produced by capture (camera or picker),
// frame ids minted monotonically on the main thread
interface Frame {
  id: FrameId;
  bitmap: ImageBitmap;
}

interface FrameAnalysis {
  frameId: FrameId;
  frameSize: { width: number; height: number };
  cards: DetectedCard[];
  timings: Record<string, number>;  // per-stage ms
}
```

Notes:

- `FrameAnalysis` contains no sets. The worker reports what it sees;
  set-finding is main-thread pure logic.
- Per-attribute confidence (not one overall score) because classification
  failures are per-attribute (striped-vs-solid in bad light is the classic
  case). Confidence comes from classification decision margins.
- `frameId` + `frameSize` make each analysis self-describing so the
  overlay transform needs no side-channel state, and stale results are
  detectable in live mode.

## Set logic (`src/set/`)

Pure TypeScript over `model/`; zero other dependencies.

The domain fact that shapes the API: for any two cards, exactly one third
card completes a set (per attribute: same → same, different → the
remaining value).

```ts
function thirdCard(a: Card, b: Card): Card;   // the fundamental operation
function isSet(a: Card, b: Card, c: Card): boolean;  // derived from it

type SetTriple = [CardId, CardId, CardId];

interface Tableau {
  entries: { id: CardId; card: Card }[];
  // internal: Map<CardKey, CardId[]> for membership lookup
}

function makeTableau(entries: { id: CardId; card: Card }[]): Tableau;
function findSets(t: Tableau): SetTriple[];   // O(n²) pair-completion
function hasSet(t: Tableau): boolean;         // same, early exit
```

- `findSets` iterates pairs and looks up `thirdCard` membership by
  `CardKey` — O(n²) instead of O(n³). (Solver speed is never the
  bottleneck; this structure is chosen because it is also the cleanest.)
- Sets are identified by `CardId`, not position or `CardKey`: ids survive
  filtering/reordering of card lists, join back to quads for highlighting,
  and stay meaningful across frames once tracking exists.
- The membership map is a multimap because detection can produce duplicate
  faces (impossible in a real deck, inevitable in CV). A `SetTriple` is
  three distinct detections.
- `Tableau` is an immutable value rebuilt per analysis. No incremental
  add/remove API; at n ≤ ~21 rebuilding is cheaper than bookkeeping.

## Vision adapter (`src/vision/`)

The adapter is task-level, not primitive-level. It speaks the domain's
verbs and says nothing about how they are implemented, so a future
implementation swap (different CV library, or a small ML detector) is
per-task, not a re-creation of OpenCV's API surface.

```ts
interface CardVision {
  // find card-shaped regions in a frame
  detectCards(frame: ImageData, options?: DetectOptions): Quad[];

  // perspective-correct one card to the canonical raster
  // (fixed size, long edge horizontal)
  rectifyCard(frame: ImageData, quad: Quad): ImageData;

  // find the symbol regions within a rectified card
  segmentSymbols(card: ImageData): SymbolRegion[];
}

interface SymbolRegion {
  outline: Point[];  // traced contour, card-raster coordinates
  hull: Point[];     // its convex hull
}
```

- Plain data in and out (`ImageData`, `Point[]`). No opaque handles, no
  manual resource release; each implementation call converts to its
  internal representation and frees it internally. The redundant
  conversion cost is milliseconds per photo — irrelevant for v1. If live
  mode profiling ever says otherwise, a handle-based interface is a
  contained change inside `vision/`.
- The OpenCV.js implementation lives in `src/vision/opencv/`. OpenCV
  types, WASM loading, and Mat memory management never leak past it.
  Inside `detectCards`: downscale (~1024px long edge), grayscale,
  adaptive threshold, contour trace, filter to plausible convex 4-corner
  card-aspect polygons, order corners, scale coordinates back to source
  resolution. Inside `segmentSymbols`: threshold card interior, trace
  symbol contours, compute hulls.
- Swappability is real but bounded: replacing the implementation means
  reimplementing three task functions against fixture-level expectations.

## Pipeline (`src/vision/pipeline/`, runs in worker)

`analyze` orchestrates the adapter plus pure-TS classification:

```
analyze(vision, imageData):
  quads = vision.detectCards(imageData)
  for each quad:
    raster  = vision.rectifyCard(imageData, quad)
    symbols = vision.segmentSymbols(raster)
    card, confidence = classify(raster, symbols)
  → FrameAnalysis
```

`classify(raster, symbols)` is pure TypeScript over plain data — no
adapter involvement:

- **count** — number of symbol regions (size-sanity-filtered).
- **color** — hue statistics of saturated raster pixels within symbol
  outlines → red/green/purple.
- **shape** — geometry of a symbol outline: solidity (outline area / hull
  area) separates squiggle (non-convex); corner structure separates
  diamond (polygonal) from oval (smooth convex).
- **fill** — interior pixel statistics: open ≈ white, solid ≈ saturated,
  striped ≈ mixed with high local variation.
- **confidence** — per-attribute decision margin (winner vs runner-up).

`classify` is a natural second seam: if classification ever goes ML, the
interface is already the standalone verb `classify(raster) → card`.
That interface is not pre-built.

Detection stays parameterized by processing resolution (`DetectOptions`)
and detect/classify remain separable stages — live mode will want
downscaled frames and, eventually, re-classification only of moved cards.

## Worker protocol (`src/worker/`)

### Protocol map

One source of truth ties each request kind to its response family;
everything is derived from it:

```ts
interface WorkerProtocol {
  init: {
    request:  { type: "init" };
    response: { type: "ready" }
            | { type: "init-error"; message: string };
  };
  analyze: {
    request:  { type: "analyze"; frameId: FrameId; bitmap: ImageBitmap;
                options?: DetectOptions };
    response: { type: "result"; frameId: FrameId;
                analysis: FrameAnalysis }
            | { type: "dropped"; frameId: FrameId }
            | { type: "analyze-error"; frameId: FrameId;
                stage: PipelineStage; message: string };
  };
}

type RequestKind = keyof WorkerProtocol;
type RequestOf<K extends RequestKind>  = WorkerProtocol[K]["request"];
type ResponseOf<K extends RequestKind> = WorkerProtocol[K]["response"];

type PipelineStage = "detect" | "rectify" | "segment" | "classify";
```

- Client: the single `postMessage` wrapper is
  `post<K>(req: RequestOf<K>): Promise<ResponseOf<K>>` — a request kind
  can only resolve with its own response family.
- Worker: dispatch through a mapped handler table
  `{ [K in RequestKind]: (req: RequestOf<K>) => Promise<ResponseOf<K>> }`
  plus `assertNever` exhaustiveness on the discriminant.
- Boundary: `event.data` is narrowed through thin hand-rolled guards on
  the discriminant before entering typed code. No schema library — we
  control both ends and ship them in one build.
- Correlation (matching a response's `frameId` to its pending promise) is
  runtime, via the client's pending-frames table.

### Lifecycle

```
uninitialized ──init──▶ initializing ──▶ ready ⇄ processing
                             │
                             └──▶ failed        (terminal)
```

- Initialization is an explicit request, not a side effect of spawning:
  the client controls when the ~8MB WASM load happens. Every response
  correlates to a request; there are no unsolicited messages.
- Sequencing is enforced client-side. Worker contract: `analyze` before
  `ready` is a protocol violation (errors, does not queue).
- Backpressure is newest-wins, depth 1: the worker holds at most one
  waiting frame; a newer `analyze` replaces it and the replaced frame is
  answered `dropped`. Barely fires in v1 (UI awaits each result); exactly
  the semantics live mode needs.
- `failed` is terminal; recovery is replacement (dispose + fresh client),
  surfaced in the UI as retry. The worker never dies from a bad frame:
  every pipeline stage is wrapped, and a throw becomes a structured
  `analyze-error` with the failing `stage` attached.
- Frames transfer as `ImageBitmap` transferables (zero-copy); responses
  are plain structured-clone data (brands are compile-time-only).

### Client façade (`src/app/`)

```ts
interface WorkerClient {
  init(): Promise<void>;    // spawn + init; idempotent, cached promise
  analyze(frame: Frame, options?: DetectOptions):
    Promise<FrameAnalysis | null>;   // null = superseded (dropped)
  dispose(): void;          // terminate; in-flight promises reject
                            //   with a distinct disposed error
}
```

`analyze()` awaits the cached `init()` promise internally, so callers
never think about warm-up; the app still calls `init()` eagerly at
startup so WASM loading overlaps with the user framing their shot.

### Highlight join (`src/app/highlights.ts`)

The id-based join between solver output and geometry lives in one helper:

```ts
function findSetsInAnalysis(analysis: FrameAnalysis): {
  triples: SetTriple[];
  quadsFor(triple: SetTriple): Quad[];   // Map<CardId, DetectedCard>
};
```

## UI / app flow (`src/ui/`, `src/app/`)

One page, four states:

```
idle ──capture/upload──▶ analyzing ──▶ results
 ▲                          │             │
 └───────── retake ◀────────┴─(error)─────┘
```

- **idle** — two first-class capture paths:
  - Camera: `getUserMedia` live viewfinder (`<video>`) with an in-app
    shutter. The viewfinder does no analysis in v1; it is where live mode
    plugs in later. Capture = `createImageBitmap(videoEl)` (video-frame
    resolution is sufficient at tabletop distance; `ImageCapture
    .takePhoto()` rejected for patchy support — revisit only if
    classification wants more pixels).
  - Photo picker: `<input type="file" accept="image/*">`, the native
    out-of-process sheet. Requires no permission on iOS/Android (the
    user's selection is the authorization) and includes a "Take Photo"
    option via the system camera. If `getUserMedia` permission is denied
    or unavailable, the capture UI collapses to this path with a one-line
    note — a fully working app, including fresh photos; the only lost
    capability is the live viewfinder.
  - Both paths funnel into `createImageBitmap` → one `Frame`.
- **analyzing** — captured photo dimmed with progress. Indicator
  distinguishes "warming up" (init still in flight) from "analyzing".
- **results** — photo with overlay: all detected cards outlined faintly,
  set members highlighted boldly. Multiple sets → chips to cycle among
  them (overlay restyles from the same `FrameAnalysis`; no reprocessing —
  this is why annotation is main-thread-side and never baked into the
  image). Tapping a card shows what it was read as. "No set found" and
  "no cards detected" are distinct outcome states with different
  guidance — neither is an error.
- Overlay: `<canvas>` absolutely positioned over the displayed image,
  drawing quads through a `ViewportTransform` (source-frame px →
  displayed px, computed from the image element's layout box, recomputed
  on resize/orientation). For a still photo the transform is static; the
  same math serves a `<video>` element in live mode.

Components stay thin: `<App>` owns the state machine (a reducer) and the
`WorkerClient`; `<Capture>` (viewfinder + picker), `<AnalysisView>`
(photo + `<ResultOverlay>` + set chips). Vision/domain logic stays out of
components — they render model values and dispatch events.

## Error handling

Outcomes (normal, get UI states) vs failures (exceptional, get error
surfaces). "No cards" / "no set" are outcomes.

- **Engine init failed** — full-screen explanation + retry (fresh
  `WorkerClient`). Distinguishes "couldn't load" (network before first
  cache) from "not supported" (WASM/browser capability).
- **Analysis failed** — back to the photo with actionable guidance;
  the `stage` field tunes the hint (detect → framing/lighting advice;
  classify → get closer). Retake keeps the flow moving.
- **Camera denied/absent** — not an error screen; capture collapses to
  the picker path (see UI section).
- **Superseded (`null`)** — silently ignored; a newer frame's result is
  coming by construction.
- **Low confidence** — not a failure. Below-threshold cards render with
  an "uncertain" treatment (e.g., dashed outline); the solver still runs
  on them; tapping a card reveals the reading so a misread producing a
  wrong set is user-catchable. Honest uncertainty over false authority.

## Testing

Three rings matching the dependency structure; test files colocated with
modules (`card.test.ts` next to `card.ts`); shared utilities and fixtures
in `test/`. All rings run headless in GitHub Actions; deploy gates on
green.

1. **Pure domain (`model/`, `set/`)** — exhaustive unit tests: all 81
   cards round-trip `cardKey`; `thirdCard` algebra (commutativity,
   self-inverse `thirdCard(a, thirdCard(a, b)) === b`); `findSets`
   against hand-built tableaus including duplicate faces.
2. **Vision pipeline, fixture-driven** — OpenCV.js runs in Node, so
   vitest exercises the real implementation end-to-end. Fixtures =
   real photos (varied lighting, angle, background) + JSON labels
   (expected `CardKey` per card, rough position). Assertions are
   task-level ("finds 12 cards, reads them correctly") so they survive
   implementation swaps. Classifier sub-fixtures: pre-rectified rasters
   with expected attributes — where striped-vs-solid tuning happens.
   Building the fixture set is a real early workstream: the photos drive
   heuristic development, not just guard it.
3. **App layer** — `WorkerClient` against a fake worker (type-checked via
   the protocol map); state-machine reducer unit tests;
   `ViewportTransform` math tests. No browser-automation suite in v1;
   manual smoke on a real phone.

## PWA & deployment

- `vite-plugin-pwa` (Workbox): precache the entire build output including
  OpenCV WASM/JS — that is what makes offline real and repeat visits skip
  the 8MB download. `autoUpdate` strategy; no update toast in v1.
- Manifest: standalone display, portrait-primary.
- GitHub Pages: `base: "/vsetp/"` in Vite config (manifest scope and SW
  paths inherit it); deploy `dist/` via GitHub Actions. HTTPS (required
  for `getUserMedia`) comes free.
- Dev mode: service worker disabled (Vite default).

## Module layout

```
./
  bin/            # dev scripts (fixture capture/label helpers)
  src/
    model/        # domain types + identities. Zero deps.
    set/          # thirdCard, tableau, findSets. Depends on model/ only.
    vision/
      adapter.ts  # CardVision interface + SymbolRegion, DetectOptions
      opencv/     # OpenCV.js implementation
      pipeline/   # analyze, classify/{count,color,shape,fill}
    worker/       # worker entry, protocol map, guards, handler table
    app/          # WorkerClient, highlights join, state machine
    ui/           # React components
  test/           # shared test utils, fixtures/
  dist/           # build output (not in source control)
```

Dependency rule: `model/` ← everything; `set/` and `vision/` never import
each other; only `worker/` and `vision/opencv/` know OpenCV exists; only
`ui/` knows React exists.

## Live-mode accommodations (designed-for, deferred)

Bought now (cheap): `ImageBitmap` as the universal frame currency;
frame-correlated protocol with newest-wins drop semantics; results in
source-frame coordinates with overlay as a separate transformed layer;
`CardId` as the join identity, ready to become cross-frame-stable;
detection parameterized by resolution; detect/classify separable.

Explicitly deferred (not designed): tracking, temporal smoothing,
per-frame scheduling, incremental tableau updates, handle-based adapter
for zero-copy frame reuse.
