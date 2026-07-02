# Set Detector — Design

2026-07-02 · Rev 2 (incorporates four-persona design audit: CV,
web-platform, architecture, mobile UX)

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
  photos (with a held-out validation set; see Testing).
- The **single-threaded** OpenCV.js build. GitHub Pages cannot serve
  COOP/COEP headers, so `SharedArrayBuffer`/pthreads builds are out of
  scope.
- React + Vite + TypeScript single-page app.
- Vision pipeline runs in a web worker; set-solving and rendering on the
  main thread.
- Installable, offline-capable PWA (service worker precaches everything,
  including OpenCV WASM). Deployed to GitHub Pages.
- All data crossing any boundary (worker/main, pipeline/UI, fixtures) is
  plain structured-clone-safe data: no classes, no library types.

## Platform baseline

- Target: iOS Safari ~15+, Android Chrome, evergreen desktop browsers.
- v1 deliberately avoids `createImageBitmap` and `OffscreenCanvas` as
  hard dependencies (see Capture normalization) — capture needs only
  canvas 2D, `getUserMedia`, workers, and WASM.
- Known WebKit limitation: `getUserMedia` is unavailable in *installed*
  (home-screen/standalone) web apps on iOS (WebKit bug 185448). The
  camera path collapses to the picker path on **capability absence**,
  not only on permission denial. Live mode's roadmap is scoped to
  desktop/Android and iOS-in-browser accordingly.
- Manifest orientation is best-effort (iOS ignores it); both
  orientations are supported and the overlay transform handles rotation.

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
detection is this?" — unique within a frame; **minted by `analyze()` as
sequential frame-local ids in the detection loop**; reserved to become
stable across frames when live-mode tracking exists. Numeric base-3 card
indexing is a private implementation detail if an implementation wants
it; it is not public API.

### Frames, geometry, analysis results

All geometry is in **normalized-frame pixel coordinates** — the
coordinate space of the frame produced by capture normalization, which
is by construction also the space of the displayed image.

```ts
interface Point { x: number; y: number }
type Quad = [Point, Point, Point, Point];  // see corner-ordering note
                                           // under Vision adapter

type FrameId = number & { readonly __brand: "FrameId" };

// the unit of pipeline input; produced by capture normalization,
// frame ids minted monotonically on the main thread
interface Frame {
  id: FrameId;
  width: number;
  height: number;
  pixels: ArrayBuffer;   // RGBA, width * height * 4; transferable
}

interface AttributeConfidence {
  count: number; color: number; shape: number; fill: number;  // 0..1
}

interface DetectedCard {
  id: CardId;
  quad: Quad;
  card: Card;
  confidence: AttributeConfidence;
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
- Per-attribute confidence (not one overall score) because
  classification failures are per-attribute. Each attribute's raw
  decision margin is **normalized per-attribute against fixture-derived
  scales** before it becomes a 0..1 confidence — a hue margin and a
  solidity margin are not comparable raw. Count is a tally, not a
  1-of-N choice; its confidence is defined separately (consistency of
  region sizes and separation from the size-filter cutoffs).
- `frameId` + `frameSize` make each analysis self-describing so the
  overlay transform needs no side-channel state, and stale results are
  detectable in live mode. The worker request handler stamps `frameId`
  into the analysis.

## Capture normalization (`src/app/capture.ts`)

The single point where every input becomes a `Frame`, resolving EXIF
orientation, memory bounds, and the display-source problem in one
mechanism:

1. Decode the source: camera path draws the live `<video>` element;
   picker path decodes the `File` (via `createImageBitmap(file,
   { imageOrientation: "from-image" })` where supported, else `<img>`
   decode — modern `drawImage` applies EXIF orientation for both).
   Undecodable formats (e.g. HEIC on non-Safari desktop; iOS transcodes
   to JPEG on upload, so this is rare) surface as a capture error with
   "unsupported format" guidance.
2. Draw once onto a normalization canvas, **clamped to
   `NORMALIZED_MAX_DIMENSION` (initial value 3072)** on the long edge.
   Orientation is baked; full-resolution `ImageData` for a 12MP photo is
   never materialized. The clamp value is coupled to the card-raster
   budget (a card spanning ~1/5 of the frame's long edge must still
   yield the raster resolution below) and sits under iOS canvas-area
   limits; it is a named constant tuned against fixtures.
3. From that one canvas derive **both** artifacts:
   - the **display source** (the canvas itself / an object URL from
     `toBlob`, revoked on retake) — what the results screen renders
     under the overlay;
   - the **analysis frame** — `getImageData` → `Frame`, whose `pixels`
     buffer is *transferred* (zero-copy) to the worker.

Because both derive from the same canvas, the analyzed frame and the
displayed image share one coordinate space by construction — overlay
quads cannot be rotated or scaled relative to what the user sees. The
transferred buffer detaching on the main thread is harmless; the display
source is a separate artifact.

The worker reconstructs `ImageData` from the buffer
(`new ImageData(new Uint8ClampedArray(pixels), width, height)`); no
OffscreenCanvas needed. Live-mode note: this same path works per-frame
at small dimensions; a capability-gated `ImageBitmap`/OffscreenCanvas
payload is a possible later optimization, not a v1 dependency.

Camera constraints: `facingMode: "environment"` with a high `ideal`
resolution. The viewfinder-frame path must be validated **early**
against the striped-fill and warm-light-purple fixtures (it yields
~1080p, the hungriest classifiers' worst case); the picker path (full
photos) is the quality reference.

## Set logic (`src/set/`)

Pure TypeScript over `model/`; zero other dependencies.

The domain fact that shapes the API: for any two cards, exactly one third
card completes a set (per attribute: same → same, different → the
remaining value).

```ts
function thirdCard(a: Card, b: Card): Card;   // the fundamental operation
function isSet(a: Card, b: Card, c: Card): boolean;  // derived from it

type SetTriple = [CardId, CardId, CardId];    // ascending CardId order

interface Tableau {
  entries: { id: CardId; card: Card }[];
  byKey: Map<CardKey, CardId[]>;   // membership lookup (multimap)
}

function makeTableau(entries: { id: CardId; card: Card }[]): Tableau;
function findSets(t: Tableau): SetTriple[];   // O(n²) pair-completion
function hasSet(t: Tableau): boolean;         // same, early exit
```

- `findSets` iterates pairs and looks up `thirdCard` membership by
  `CardKey` — O(n²) instead of O(n³). (Solver speed is never the
  bottleneck; this structure is chosen because it is also the cleanest.)
- The same triple is reachable from multiple pairs (and duplicate faces
  from multiple thirds), so triples are **canonicalized as ascending
  `CardId` tuples and deduplicated on that key** before returning.
- Sets are identified by `CardId`, not position or `CardKey`: ids
  survive filtering/reordering of card lists, join back to quads for
  highlighting, and stay meaningful across frames once tracking exists.
- `byKey` is a plain public field (a free-function API has no privacy to
  offer, and `Tableau` never crosses a serialization boundary). It is a
  multimap because detection can produce duplicate faces (impossible in
  a real deck, inevitable in CV). A `SetTriple` is three distinct
  detections.
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
  rectifyCard(frame: ImageData, quad: Quad): ImageData;

  // find the symbol regions within a rectified card
  segmentSymbols(card: ImageData): SymbolRegion[];
}

interface DetectOptions {
  maxDimension?: number;   // detection working scale, long edge px
                           // (default DETECTION_MAX_DIMENSION = 1024)
}

interface SymbolRegion {
  outline: Point[];  // filled OUTER ink boundary, raster coords
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
- Swappability is real but bounded: replacing the implementation means
  reimplementing three task functions against fixture-level (task-level)
  expectations.

### Canonical card raster

`rectifyCard` warps to **`CARD_RASTER` = 600×384** (long edge
horizontal; Set cards are ≈1.56:1). This is the most load-bearing
constant in the pipeline: striped-vs-solid fill is a spatial-frequency
measurement, and a symbol's short axis must land large enough to resolve
individual stripes (~6–7 stripe pairs across a symbol ⇒ symbols at
~100+ px short axis ⇒ ≥8 px per stripe pair). Rectification samples
from the full normalized frame (3072-clamped), **not** from the 1024
detection scale, so the raster budget holds regardless of detection
downscaling. The constant is validated directly by the striped/solid
classifier sub-fixtures.

### Corner ordering / orientation

`detectCards` orders each quad's corners **by angle about the centroid,
then rotates the ordering so the longest edge maps to the raster's top
edge** (robust under strong perspective, unlike coordinate sum/diff
tricks). This fixes orientation up to a 180° flip, which is deliberately
left unresolved: all four classifiers are orientation-invariant (count
is a tally; color and fill are pixel statistics; shape uses
rotation-invariant contour features), so the flip cannot affect a
reading. `Quad`'s corner order is defined by this rule.

### Detection robustness (inside `vision/opencv/`)

- **Primary path:** downscale to the detection scale, grayscale,
  adaptive threshold, external contours, filter to plausible convex
  4-corner card-aspect polygons, order corners, scale coordinates back
  to normalized-frame resolution.
- **Low-contrast fallback (white cards on light tables — a median Set
  situation, and the primary detection risk):** when the primary path
  yields implausibly few cards, retry with an edge-based mask (Canny +
  dilation/close to seal soft card borders) before contour finding. If
  fixtures show even that failing, the planned escalation is
  symbol-anchored detection (symbols are always high-contrast on the
  card face; cluster symbol blobs and grow card quads around them).
- **Touching/adjacent cards** merge into one non-quad blob under
  external contours and would otherwise be rejected wholesale. First
  line: morphological erosion before the aspect filter to separate
  near-touching cards. Planned escalation (implement when fixtures
  demand, and they will for tight tableaus): distance-transform +
  watershed splitting of merged card blobs (`cv.distanceTransform`,
  `cv.watershed` — both present in OpenCV.js), then quad-fit each
  segment.
- Both fallbacks are internal strategies of the OpenCV implementation —
  the `detectCards` contract doesn't change; fixtures (light table,
  touching cards, shadows) decide which paths ship enabled.

### Symbol segmentation

`segmentSymbols` must be **fill-invariant**: interior thresholding would
fragment a striped symbol into per-stripe blobs (miscounting a 1-striped
card as 3+) and reduce an open symbol to a thin ring. Instead: build a
color/saturation ink mask, take **external contours only**, and fill
each to a solid region. `SymbolRegion.outline` is that filled outer
boundary — well-defined for solid, striped, and open symbols alike.
Count derives from these filled outer contours; fill is measured
*inside* them as a separate step.

## Pipeline (`src/vision/pipeline/`, runs in worker)

`analyze` orchestrates the adapter plus pure-TS classification:

```
analyze(vision, imageData):
  quads = vision.detectCards(imageData)
  for each quad (minting sequential CardIds):
    raster  = vision.rectifyCard(imageData, quad)
    symbols = vision.segmentSymbols(raster)
    card, confidence = classify(raster, symbols)
  → cards (the worker handler stamps frameId/frameSize/timings
           into the FrameAnalysis)
```

`classify(raster, symbols)` is pure TypeScript over plain data — no
adapter involvement:

- **count** — number of symbol regions (size-sanity-filtered; regions
  are filled outer contours, so count is fill-invariant by
  construction).
- **white-balance normalization first** — every card provides its own
  reference: the card border/background is known-white. Estimate the
  card's white point from border pixels and color-correct the raster
  before any color measurement. Raw hue under warm light is the classic
  failure (red drifts orange, purple — low-saturation, red-adjacent —
  drifts red).
- **color** — classify corrected symbol-ink pixels in a perceptually
  separable space (Lab a/b, or hue + saturation jointly — decided
  against fixtures), not raw hue alone → red/green/purple.
- **shape** — a small feature vote, not one threshold:
  diamond ← `approxPolyDP` vertex count ≈ 4 with near-straight edges
  (epsilon specified as a fraction of perimeter);
  squiggle ← convexity-defect count/depth *combined with* low solidity
  (a squiggle's solidity ~0.90–0.95 sits too close to an oval's
  ~0.97–0.99 for solidity alone);
  oval ← the residual smooth-convex case.
- **fill** — pixel statistics inside the filled outline: open ≈ white,
  solid ≈ saturated, striped ≈ mixed with high local variation (the
  raster budget exists for this case).
- **confidence** — per-attribute decision margins, normalized
  per-attribute against fixture-derived scales (see Domain model note).

`classify` is a natural second seam: if classification ever goes ML,
the seam is the classify *stage boundary* (an ML variant would take the
raster alone and drop the `symbols` argument). That interface is not
pre-built.

Detection stays parameterized by working resolution (`DetectOptions`)
and detect/classify remain separable stages — live mode will want
downscaled frames and, eventually, re-classification only of moved
cards.

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
    request:  { type: "analyze"; frame: Frame;
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
- Correlation (matching a response's `frameId` to its pending promise)
  is runtime, via the client's pending-frames table.
- `frame.pixels` is transferred (zero-copy); responses are plain
  structured-clone data (brands are compile-time-only).

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
  answered `dropped`. Barely fires in v1 (UI awaits each result);
  exactly the semantics live mode needs.
- `failed` is terminal; recovery is replacement (dispose + fresh
  client), surfaced in the UI as retry. The worker never dies from a
  *handled* bad frame: every pipeline stage is wrapped, and a throw
  becomes a structured `analyze-error` with the failing `stage`
  attached.
- **Worker death is not a hang:** the client wires `Worker.onerror` and
  `onmessageerror` to reject *all* in-flight promises and enter
  `failed`; a generous per-request watchdog timeout (~30s) backstops
  silent deaths (WASM OOM). Callers always settle.

### Client façade (`src/app/`)

```ts
type AnalyzeResult =
  | { status: "ok"; analysis: FrameAnalysis }
  | { status: "superseded" };   // dropped: a newer frame's result is
                                //   coming by construction

interface WorkerClient {
  init(): Promise<void>;    // spawn + init; idempotent, cached promise
  analyze(frame: Frame, options?: DetectOptions):
    Promise<AnalyzeResult>;    // rejects on analyze-error / death /
                               //   timeout / disposal (distinct errors)
  dispose(): void;
}
```

`analyze()` awaits the cached `init()` promise internally, so callers
never think about warm-up.

**Init timing policy:** eager `init()` at startup by default, so WASM
loading overlaps with the user framing their shot. On an uncached first
run over a metered connection (`navigator.connection.saveData`, where
available), defer the fetch to first capture intent instead. Either
way, first-run download progress is **determinate and shown at idle**
(streamed fetch with Content-Length / precache progress), not a bare
spinner discovered after the shutter — and the viewfinder remains
usable while it runs. The "warming up" vs "analyzing" indicator states
are distinct and the former shows progress.

### Highlight join (`src/app/highlights.ts`)

The id-based join between solver output and geometry lives in one
helper:

```ts
function findSetsInAnalysis(analysis: FrameAnalysis): {
  triples: SetTriple[];
  quadsFor(triple: SetTriple): Quad[];   // Map<CardId, DetectedCard>
};
```

## UI / app flow (`src/ui/`, `src/app/`)

One page, three states plus error surfaces:

```
idle ──capture/upload──▶ analyzing ──▶ results
 ▲                        │   │           │
 └────── cancel ◀─────────┘   │           │
 ◀──────── retake ◀───(error)─┴───────────┤
                              re-analyze ─┘ (same frame, back to
                                             analyzing)
```

- **idle** — two first-class capture paths:
  - Camera: `getUserMedia` live viewfinder (`<video>`) with an in-app
    shutter. **Permission is primed:** the viewfinder mounts behind an
    explanatory "Enable camera" CTA (user-gesture-triggered), never a
    cold prompt on load — reflexive denials are sticky on iOS. The
    viewfinder does no analysis in v1; it is where live mode plugs in
    later. A brief hold-steady hint accompanies the shutter (motion
    blur is a first-class capture risk for fill classification; burst
    capture with sharpest-frame selection is noted as a future
    mitigation, deferred).
  - Photo picker: `<input type="file" accept="image/*">`, the native
    out-of-process sheet. Requires no permission on iOS/Android (the
    user's selection is the authorization) and includes a "Take Photo"
    option via the system camera.
  - If `getUserMedia` is unavailable (capability — including iOS
    installed-PWA — or denial), the capture UI collapses to the picker
    path with a note that includes the **recovery path** (system camera
    still works via the picker; how to re-enable the site's camera
    permission; a reload is needed after changing it).
  - Both paths funnel into capture normalization → one `Frame` + one
    display source (see Capture normalization).
- **analyzing** — captured photo shown dimmed with progress and a
  **cancel** action returning to idle. Indicator distinguishes
  "warming up" (determinate download progress) from "analyzing".
- **results** — the photo with the overlay, plus a **DOM results panel**
  (primary, not decorative — see Accessibility):
  - overlay: all detected cards outlined faintly, set members
    highlighted boldly; multiple sets → chips to cycle among them
    (overlay restyles from the same `FrameAnalysis`; no reprocessing —
    this is why annotation is main-thread-side and never baked into the
    image).
  - actions: retake; **re-analyze** (re-runs the pipeline on the same
    retained `Frame`, optionally at a higher detection resolution via
    `DetectOptions` — a wrong read shouldn't force re-shooting a good
    photo).
  - "No set found" and "no cards detected" are distinct outcome states
    with different guidance — neither is an error.
- Overlay: `<canvas>` absolutely positioned over the displayed image,
  drawing quads through a `ViewportTransform` (normalized-frame px →
  displayed px, computed from the image element's layout box,
  recomputed on resize/orientation). For a still photo the transform is
  static; the same math serves a `<video>` element in live mode.

### Accessibility & results legibility

- **The canvas is never the sole representation.** The results panel is
  DOM: an ARIA-live summary ("1 set found") and a focusable list of
  detected cards with their readings — this is also the primary
  reading affordance on a phone, where 12–15 skewed quads make tiny tap
  targets. Canvas taps are an accelerator: hit regions are expanded to
  a minimum effective size, and ambiguous taps surface a small chooser.
- **Color-vision safety is a hard constraint on the overlay palette:**
  highlight colors must be distinguishable under common CVD *and*
  distinct from the card hues themselves (red/green/purple); line
  weight and style — not hue — are the primary highlight channel. The
  uncertain treatment is dashed (non-color). Card readings are always
  words ("red"), never a swatch alone. This app can be a genuine aid to
  color-blind players — the CV reads color *for* them — so this is a
  feature, not just compliance.
- Install choreography: contextual install CTA after a first successful
  analysis (not an interrupting prompt on load); iOS gets a manual
  "Add to Home Screen" hint. (Note the iOS standalone camera limitation
  under Platform baseline.)

Components stay thin: `<App>` owns the state machine (a reducer) and the
`WorkerClient`; `<Capture>` (viewfinder + picker), `<AnalysisView>`
(photo + `<ResultOverlay>` + results panel + set chips). Vision/domain
logic stays out of components — they render model values and dispatch
events.

## Error handling

Outcomes (normal, get UI states) vs failures (exceptional, get error
surfaces). "No cards" / "no set" are outcomes.

- **Engine init failed** — full-screen explanation + retry (fresh
  `WorkerClient`). Distinguishes "couldn't load" (network before first
  cache) from "not supported" (WASM/browser capability).
- **Analysis failed** — back to the photo with guidance. Guidance is
  **condition-based and localized, not stage-generic**: the analysis
  already carries what's needed to say *which* cards/regions failed.
  Tabletop-real hints, in priority order:
  - cards touching the frame edge (cheap: quads near bounds) →
    "some cards are cut off";
  - blown-out specular regions (cheap: saturation/value stats) →
    "glare — tilt the phone away from the light";
  - shadow/shake phrasing ("avoid casting a shadow", "hold steady")
    over the useless generic "more light"/"get closer" (which
    contradicts fitting the spread in frame);
  - a single unreadable card among many reads as an uncertain *card*
    (dashed, low confidence), not a whole-frame failure.
- **Capture failed** (undecodable file) — "unsupported format" at the
  picker.
- **Camera denied/absent** — not an error screen; capture collapses to
  the picker path with recovery guidance (see UI section).
- **Superseded** — silently ignored; a newer frame's result is coming
  by construction.
- **Low confidence** — not a failure. Below-threshold attributes render
  the card with the uncertain treatment; the solver still runs on it;
  the results panel shows the reading so a misread producing a wrong
  set is user-catchable. Honest uncertainty over false authority.

## Performance budgets

- `analyze` (warm engine): **≤ 500ms typical, 1s hard ceiling** on a
  mid-tier phone for a 12–15 card tableau at the 3072 normalized frame.
  This is an estimate-backed budget (detection at 1024px is tens of ms;
  ~15 warps to 600×384 at ~5ms each; segmentation and pure-TS pixel
  stats a few ms per card), not aspiration — ring-2 fixtures record
  `timings` per stage so the stage that blows it is visible, and the
  budget is the acceptance criterion for resolution/raster choices.
  Live-mode note: this budget is a *still-path* cost at
  quality-maximized settings — live mode does not run it per frame.
  The live decomposition is: detection only per frame at reduced
  resolution (target ≤ ~30–50ms — the `timings` instrumentation
  verifies this scale early), classification amortized to
  once-per-card via tracking-stable `CardId`s (unmoved cards keep
  their reading), highlights following cheap per-frame quads. That is
  what detect/classify separability and the id design exist for.
- App JS bundle (excluding OpenCV artifacts): **≤ 200KB gzipped**.
- OpenCV single-threaded WASM+JS: ~8–11MB, precached (see PWA).

## Testing

Three rings matching the dependency structure; test files colocated with
modules (`card.test.ts` next to `card.ts`); shared utilities and
fixtures in `test/`. All rings run headless in GitHub Actions; deploy
gates on green — including the held-out fixture set.

1. **Pure domain (`model/`, `set/`)** — exhaustive unit tests: all 81
   cards round-trip `cardKey`; `thirdCard` algebra (commutativity,
   self-inverse `thirdCard(a, thirdCard(a, b)) === b`); `findSets`
   against hand-built tableaus including duplicate faces and triple
   dedup/canonicalization.
2. **Vision pipeline, fixture-driven** — OpenCV.js (single-threaded
   build) runs in Node, so vitest exercises the real implementation
   end-to-end. **Harness is a real early workstream, not free:** async
   WASM init in `beforeAll` (with generous timeout; known vitest
   hang-arounds), plus an image-decode → `ImageData` shim (node-canvas
   or sharp/jimp) since Node lacks both decoding and the `ImageData`
   global.
   - **Fixture discipline:** fixtures split into a *tuning set*
     (heuristics may be fitted against it) and a *held-out validation
     set* (never fitted against; gates deploy). Metrics are
     per-attribute confusion matrices, not just "reads 12/12".
   - **Coverage matrix** (required, drives photo collection — an early
     workstream): all three fills including striped at small scale;
     purple *and* red under warm/incandescent light; white cards on a
     light table; touching/tight tableaus; strong perspective and
     rotation; shadowed frames; EXIF-oriented portrait phone shots.
   - Classifier sub-fixtures: pre-rectified card rasters with expected
     attributes — where striped-vs-solid and the raster-size budget are
     validated, and where the camera-path (~1080p) resolution question
     is answered early.
   - Assertions are task-level ("finds 12 cards, reads them correctly")
     so they survive implementation swaps.
3. **App layer** — `WorkerClient` against a fake worker (type-checked
   via the protocol map), including death/timeout paths; state-machine
   reducer unit tests (incl. cancel and re-analyze); capture
   normalization (orientation baked, clamp respected — jsdom/canvas);
   `ViewportTransform` math tests. No browser-automation suite in v1;
   manual smoke on a real phone.

## PWA & deployment

- `vite-plugin-pwa` (Workbox): precache the entire build output
  including OpenCV WASM/JS. **Required, easily-forgotten config:**
  Workbox's `maximumFileSizeToCacheInBytes` defaults to 2 MiB, which
  silently excludes (or, in current vite-plugin-pwa, fails the build
  on) the ~8MB WASM — set it to ≥ 10 MiB or offline is fiction.
- OpenCV artifacts must be **content-hashed and stable across deploys**
  so an unchanged 8MB binary keeps its precache entry and `autoUpdate`
  doesn't silently re-download it on every deploy.
- `autoUpdate` strategy; no update toast in v1.
- Manifest: standalone display; orientation best-effort (see Platform
  baseline); icons from the card motif.
- GitHub Pages: `base: "/vsetp/"` in Vite config (manifest scope and SW
  paths inherit it); deploy `dist/` via GitHub Actions. HTTPS (required
  for `getUserMedia`) comes free. No COOP/COEP → single-threaded
  OpenCV build (see Decisions).
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
      opencv/     # OpenCV.js implementation (incl. detection fallbacks)
      pipeline/   # analyze, classify/{count,color,shape,fill}
    worker/       # worker entry, protocol map, guards, handler table
    app/          # WorkerClient, capture normalization, highlights,
                  #   state machine
    ui/           # React components
  test/           # shared test utils, fixtures/{tuning,holdout}/
  dist/           # build output (not in source control)
```

Dependency rule: `model/` ← everything; `set/` and `vision/` never
import each other; only `worker/` and `vision/opencv/` know OpenCV
exists; only `ui/` knows React exists.

## Live-mode accommodations (designed-for, deferred)

Bought now (cheap): normalized RGBA frames as the universal currency
(the same normalization path serves video frames at small dimensions);
frame-correlated protocol with newest-wins drop semantics; results in
normalized-frame coordinates with overlay as a separate transformed
layer; `CardId` as the join identity, ready to become
cross-frame-stable; detection parameterized by resolution;
detect/classify separable.

Explicitly deferred (not designed): tracking, temporal smoothing,
per-frame scheduling, incremental tableau updates, burst capture with
sharpest-frame selection, capability-gated ImageBitmap/OffscreenCanvas
frame payloads, handle-based adapter for zero-copy frame reuse. Note:
live mode on iOS is scoped to in-browser use (installed-PWA camera
limitation).
