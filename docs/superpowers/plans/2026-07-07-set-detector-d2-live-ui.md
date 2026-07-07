# Plan D2: Live UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ambient live experience on top of the D1 engine:
persistent camera, rVFC frame loop with adaptation, track-keyed
ghost overlay, live reveal modes, per-card feedback with export, and
a serialized Live/Still mode toggle.

**Architecture:** Camera ownership hoists to a `CameraProvider`
above `Session` (failure overlays a mounted stage). A `LiveDriver`
paces `captureLiveFrame` → `sendLiveFrame`; `live-update`s dispatch
into a new reducer `live` phase which derives locked-track sets,
presence debounce, and announcement milestones as pure state. The
live stage renders track-keyed ghosts with CSS interpolation;
feedback taps hit-test RENDERED positions and convert to frame
coordinates.

**Tech Stack:** React 18, TypeScript, Vitest; D1 engine
(worker-client live API, tracker constants, SetIdentity).

**Spec:** `docs/superpowers/specs/2026-07-06-live-viewfinder-design.md`
(rev 2). The D1 final review's "Guidance for Plan D2" (ledger,
`.superpowers/sdd/progress.md`) is BINDING. Where plan and spec
disagree, STOP and escalate.

## Global Constraints

- 80-char lines; double quotes; prettier-clean.
- TDD all pure logic; `npx tsc -b` gates components; `npm test` AND
  `npm run build` green before every commit (FULL summary lines).
- A11y invariants (HARD): the App-level aria-live region mounts once
  and never remounts; announcement text is pure `announcementFor`;
  spoiler parity in every reveal mode across ALL channels; visuals
  `aria-hidden`; uncertainty = dashed, never hue.
- Spoiler parity mechanism: prune set DATA at the App boundary
  (below "sets" reveal, components never receive set data).
- Client wiring invariants: client-per-mount; DisposedError is
  lifecycle, not failure; serialize mode transitions (await
  `stopLive()` before `startLive()`/`analyze()`).
- `sendLiveFrame` transfers `frame.pixels` (neutered) — mint a fresh
  buffer per capture; never reuse.
- Tracker constants import from `src/worker/tracker.ts` — never copy
  values into UI code.
- React keys: ghosts by `trackId`; sets by `SetIdentity`.
- Spec constants verbatim: `LIVE_FRAME_MAX_DIMENSION = 768`,
  `PRESENCE_DEBOUNCE_UPDATES = 5`, `NO_CARDS_GRACE_MS = 4000`,
  `STALL_MS = 5000`; ladder rungs 768 → 640 → 512 (floor), downshift
  after ≥3s sustained < 4 updates/s, upshift after 30s sustained
  > 6/s.
- Touch targets ≥ 44×44 pt; HUD honors safe-area insets.

---

### Task 1: captureLiveFrame + client liveness signal

**Files:**
- Create: `src/app/live-capture.ts`, `src/app/live-capture.test.ts`
- Modify: `src/app/worker-client.ts` (+ its test),
  `test/synthetic/sequence.ts` (import the constant; delete the
  local literal + sync-by-hand comment)

**Interfaces:**
- Produces:

```ts
export const LIVE_FRAME_MAX_DIMENSION = 768;

export interface VideoLike {
  videoWidth: number;
  videoHeight: number;
}
export interface ContextLike {
  drawImage(source: unknown, dx: number, dy: number,
    dw: number, dh: number): void;
  getImageData(x: number, y: number, w: number, h: number): ImageData;
}
export interface CanvasLike {
  width: number;
  height: number;
  getContext(id: "2d"): ContextLike | null;
}
export interface LiveFrameCapture {
  frame: Frame;
  captureMs: number;
}
// Persistent-canvas capturer: ONE canvas for the session, resized
// only when video dimensions change; pixels only — no toBlob, no
// object URLs, ever (spec).
export function createLiveCapturer(
  makeCanvas: () => CanvasLike = () =>
    document.createElement("canvas") as unknown as CanvasLike,
): (video: VideoLike) => LiveFrameCapture
```

  Uses `clampedSize(w, h, LIVE_FRAME_MAX_DIMENSION)` and
  `mintFrameId()` from `src/app/capture.ts`. `captureMs` measures
  draw+read via `performance.now()`.
- worker-client: `startLive(onUpdate, onSignal?)` — optional
  `onSignal(): void` invoked on EVERY live-relevant worker message:
  `live-update`, `dropped` with no pending entry (live drop),
  `mark-ack`, and `analyze-error` with no pending entry (live
  pipeline error). D1 final review Issue 1: without this, a
  slow-but-alive worker (frames displaced, few completions) is
  indistinguishable from a dead one and the 5s stall check would
  false-kill it. Clear the callback in `stopLive`/`failAll`.

- [ ] **Step 1: Failing tests** — live-capture: fake CanvasLike
  records constructions/resizes; assert (a) frame long edge is 768
  for a 1920×1080 VideoLike and pixels length w*h*4; (b) TWO
  captures construct ONE canvas; (c) a video dimension change
  resizes the same canvas, no new construction; (d) fresh Frame ids
  mint per capture (monotonic); (e) `captureMs >= 0`. worker-client
  (fake-worker harness): onSignal fires on live-update, on a
  non-pending `dropped`, on `mark-ack`, and on a non-pending
  `analyze-error`; does NOT fire for still-analyze responses; stops
  firing after `stopLive()`.
- [ ] **Step 2: Run; watch fail.**
- [ ] **Step 3: Implement** both; update `sequence.ts` to import
  `LIVE_FRAME_MAX_DIMENSION` from `../../src/app/live-capture`.
- [ ] **Step 4: Verify** targeted suites, then full gates.
- [ ] **Step 5: Commit** "Add live capture path and client liveness
  signal".

---

### Task 2: Identity-keyed selection (Still mode)

The D1 final review flagged `selected: number` (a triples index) as
the index-identity bug class. Fix it in Still mode BEFORE live mode
builds on identity selection.

**Files:**
- Modify: `src/app/highlights.ts` (+ test), `src/app/state.ts`
  (+ test), `src/ui/Hud.tsx`, `src/ui/AnalysisView.tsx`,
  `src/ui/Overlay.tsx` (props only if it takes selected),
  `src/ui/SetLines.tsx`, `src/ui/SrResults.tsx`, `src/ui/App.tsx`

**Interfaces:**
- `findSetsInAnalysis(analysis)` returns
  `{ sets: AnalyzedSet[] }` where
  `AnalyzedSet = { id: SetIdentity; triple: SetTriple }` (identity
  via `setIdentityOf` over the triple's member cards, from
  `src/set/identity.ts`).
- `Screen["results"]` becomes `{ ...; sets: AnalyzedSet[];
  selected: SetIdentity | null }` (replaces `triples`+index).
  `select-set` event becomes `{ type: "select-set";
  id: SetIdentity }`. Initial selected = first set's id or null.
- UI: chips render per `AnalyzedSet` keyed by `id`,
  `aria-pressed`/emphasis by identity equality; SetLines color/style
  still assigned by ARRAY ORDER index (first-appearance in a static
  result — unchanged visual), selection matched by identity.
- Reducer rule (spec): if a re-analyze produces sets that no longer
  include the selected identity, selection falls back to the first
  set (or null).

- [ ] **Step 1: Failing tests** — highlights: identities computed and
  order-stable; state: select-set by identity round-trips; reanalyze
  preserving the selected identity keeps it selected; reanalyze
  dropping it falls back to first/null. Update existing state tests
  mechanically (`selected: 0` → first identity etc.).
- [ ] **Step 2-4: Implement, verify** (announce.ts unchanged — it
  reads counts only; SrResults membership check switches from index
  to identity lookup).
- [ ] **Step 5: Commit** "Key set selection by identity, not index".

---

### Task 3: Live reducer phase + live announcements

**Files:**
- Modify: `src/app/state.ts` (+ test), `src/ui/announce.ts`
  (+ test)
- Create: `src/app/live-sets.ts` (+ test)

**Interfaces:**

```ts
// live-sets.ts — pure derivation over LOCKED tracks only (spec)
export interface LiveSet {
  id: SetIdentity;
  trackIds: [TrackId, TrackId, TrackId];
}
export function liveSetsOf(tracks: Track[]): LiveSet[]
// filter state === "locked" && reading; makeTableau<TrackId> over
// (trackId, reading); findSets; identity via setIdentityOf on the
// member readings; sort output by id for determinism.
```

```ts
// state.ts additions
export type Screen =
  | ...existing
  | {
      phase: "live";
      tracks: Track[];
      liveSets: LiveSet[];
      selected: SetIdentity | null;
      updatedAt: number | null;       // last live-update wall ms
      updateCount: number;
      presence: {                     // debounced derived signal
        shown: boolean;               // what presence mode displays
        candidate: boolean;
        streak: number;               // consecutive updates agreeing
      };
      lockedCount: number;            // last announced milestone
      emptySince: number | null;      // wall ms of zero-track start
      degraded: boolean;              // adaptation ladder below 768
    };

export type AppEvent =
  | ...existing
  | { type: "live-entered"; at: number }
  | { type: "live-update-received"; tracks: Track[]; at: number }
  | { type: "live-left" }
  | { type: "live-degraded"; degraded: boolean };
```

Reducer rules (TDD each):
- `live-entered` (from idle only): fresh live screen (empty tracks,
  presence `{shown:false,candidate:false,streak:0}`, `emptySince:
  at`, counters zeroed).
- `live-update-received` (live phase only): recompute
  `liveSets = liveSetsOf(tracks)`; `selected` keeps its identity if
  still present else first-or-null; presence debounce: candidate =
  liveSets.length > 0; equal to previous candidate → streak+1 else
  streak=1; `shown` flips ONLY when `streak >=
  PRESENCE_DEBOUNCE_UPDATES` (import the constant from state.ts —
  DEFINE it here, exported, = 5) AND candidate !== shown.
  `lockedCount` = count of locked tracks. `emptySince`: null when
  tracks.length > 0, else keeps earliest zero-track timestamp.
- `live-left`: → `{ phase: "idle", notice: null }`.
- `captured` from live phase: ALSO valid (Still shutter while live
  paused is not possible — capture only fires in Still — but keep
  the reducer total: `captured` transitions any phase to analyzing).
- `select-set` in live phase: sets `selected` (shared event).

`announcementFor` live cases (spoiler parity table — TDD every row):
- cards reveal: `"{n} cards read."` when lockedCount changes to n>0;
  base text for the live screen is derived from lockedCount.
- presence reveal: append `"A set is present."`/`"No set here."`
  from `presence.shown` (the DEBOUNCED value only).
- sets reveal: `"{k} sets found. {n} cards read."` from
  liveSets/lockedCount.
- Zero tracks with `emptySince` older than `NO_CARDS_GRACE_MS`
  (export = 4000 from announce.ts): `"No cards in view."` in EVERY
  reveal mode (aim-by-audio).
- Announcements must be value-stable between meaningful changes:
  same state → same string (the region only speaks on text change —
  this is what throttles; per-frame updates that change nothing
  produce identical strings). Test: two consecutive states differing
  only in `updatedAt`/`updateCount` produce identical announcements.

- [ ] **Steps: failing tests → implement → verify → commit**
  "Add live phase to the reducer with debounced announcements".

---

### Task 4: CameraProvider hoist + failure overlay

**Files:**
- Create: `src/ui/CameraProvider.tsx`
- Modify: `src/ui/App.tsx`, `src/ui/CaptureView.tsx`,
  `src/ui/app.css`

**Interfaces:**

```ts
export interface CameraContextValue {
  camera: CameraState; // existing src/ui/camera-state machine
  videoRef: RefObject<HTMLVideoElement>;
  enableCamera(): void;
}
export const CameraContext: React.Context<CameraContextValue | null>;
export function CameraProvider({ children }: { children: ReactNode });
```

Rules:
- Move stream/lifecycle ownership from CaptureView into
  CameraProvider VERBATIM (the StrictMode-safe `createCameraLifecycle`
  pattern, `track.onended → "stopped"`, stale-grant release). The
  `<video playsInline muted>` element renders INSIDE the provider
  (position: absolute, fills the stage, `hidden` when camera is not
  live) so both Still capture and the live loop read one element.
- App structure: the aria-live region stays exactly where it is;
  `CameraProvider` wraps `<Session key=...>` (camera survives
  retry). The engine-failed panel becomes an OVERLAY: Session
  renders the stage ALWAYS and, when `engine.status === "failed"`,
  additionally renders `<div className="failure-overlay">` (absolute
  inset-0, above stage, below nothing) with the message + Retry —
  the stage and camera stay mounted (D1/Plan-C requirement #1).
- CaptureView drops its stream code and consumes the context: the
  Enable button, "Starting camera…", unavailable copy, shutter,
  picker, notices — presentation unchanged. Its `shoot()` reads
  `videoRef` from context. Also render the Enable button in the
  `unavailable` state (Plan C final-review Minor: `cameraReduce`
  supports enable-from-unavailable; give it the affordance —
  "Try again" secondary button next to the settings advice).

- [ ] **Steps:** read current files → restructure (no new pure logic
  → no new unit tests; `npx tsc -b` + existing suites gate) → run a
  quick `npm run dev` + curl smoke, kill it → full gates → commit
  "Hoist camera ownership above Session".

---

### Task 5: Adaptation ladder + LiveDriver (frame loop, stall,
wake lock)

**Files:**
- Create: `src/app/adaptation.ts` (+ test),
  `src/app/live-driver.ts` (+ test)

**Interfaces:**

```ts
// adaptation.ts — pure ladder state machine
export const LADDER_RUNGS = [768, 640, 512] as const;
export const DOWNSHIFT_WINDOW_MS = 3000;
export const DOWNSHIFT_BELOW_PER_SEC = 4;
export const UPSHIFT_WINDOW_MS = 30_000;
export const UPSHIFT_ABOVE_PER_SEC = 6;
export interface LadderState {
  rung: number; // index into LADDER_RUNGS
  windowStart: number;
  updatesInWindow: number;
}
export function createLadder(now: number): LadderState;
// call on every live-update; returns new state + the maxDimension
// to send with subsequent frames + whether degraded (rung > 0)
export function recordUpdate(
  s: LadderState,
  now: number,
): { state: LadderState; maxDimension: number; degraded: boolean };
```

Ladder semantics (TDD): a full window elapses before judging; rate <
4/s over a ≥3s window → rung+1 (floor at 512, stay); rate > 6/s
sustained over a full 30s window → rung-1; window resets on every
shift; hysteresis dead-band = the gap between 4 and 6.

```ts
// live-driver.ts — the loop; injectable for tests
export const STALL_MS = 5000;
export interface LiveDriverDeps {
  client: Pick<WorkerClient,
    "startLive" | "sendLiveFrame" | "stopLive">;
  video: VideoLike & { readonly readyState: number };
  capture(video: VideoLike): LiveFrameCapture; // createLiveCapturer()
  onUpdate(update: LiveUpdate): void;
  onDegraded(degraded: boolean): void;
  onStall(): void;
  schedule(cb: () => void): () => void; // rVFC/rAF/interval abstraction
  now(): number;
}
export interface LiveDriver {
  start(): Promise<void>; // startLive + begin pacing + wake lock
  stop(): Promise<void>;  // stopLive + cancel pacing + release lock
}
export function createLiveDriver(deps: LiveDriverDeps): LiveDriver;
```

Driver rules (TDD with fake deps/timers):
- Each scheduled tick: if video ready, capture → `sendLiveFrame(
  frame, captureMs, { maxDimension })` with the ladder's current
  rung; reschedule.
- `onUpdate` wraps the caller's: records ladder update, forwards,
  emits `onDegraded` on rung transitions, and stamps
  `lastSignalAt`.
- The client's `onSignal` (Task 1) also stamps `lastSignalAt`.
- Stall check: a repeating timer; if `now - lastSignalAt > STALL_MS`
  while started and frames are being sent → `onStall()` ONCE, stop
  pacing (caller decides recovery). Any signal resets it (spec:
  evaluated after adaptation; any worker message resets).
- `start()` awaits `client.startLive(...)`; `stop()` awaits
  `client.stopLive()`; both idempotent; start-after-stop works
  (fresh session).
- Wake lock: `navigator.wakeLock?.request("screen")` in start,
  `release()` in stop, re-request on `visibilitychange` to visible;
  ALL failures swallowed silently (spec: opportunistic, screen
  sleep is an accepted failure mode). Feature-detect; the deps
  object may expose it injectable (`requestWakeLock?()`) for tests.
- The production `schedule` helper (exported): uses
  `video.requestVideoFrameCallback` when present, else
  `requestAnimationFrame` throttled to ~100ms via timestamp check,
  else `setInterval(cb, 100)` (spec: rVFC ≥ iOS 15.4, gated).

- [ ] **Steps: failing tests (ladder table-driven; driver with fake
  schedule/now: pacing sends frames with the rung's maxDimension;
  downshift emits onDegraded; stall fires once at >5s silence and a
  signal resets it; stop is awaited and idempotent) → implement →
  verify → commit** "Add adaptation ladder and live frame driver".

---

### Task 6: Live stage UI + Session wiring

**Files:**
- Create: `src/ui/LiveView.tsx`, `src/ui/TrackGhosts.tsx`,
  `src/ui/set-colors.ts` (+ test), `src/ui/LiveSetLines.tsx`
- Modify: `src/ui/App.tsx`, `src/ui/Hud.tsx`, `src/ui/SrResults.tsx`,
  `src/ui/app.css`

**Interfaces:**

```ts
// set-colors.ts — pure, session-scoped first-appearance color map
export function createSetColorMap(): {
  colorFor(id: SetIdentity): { color: string; dash: boolean };
};
// assigns SET_LINE_COLORS[n % 4] + dash for n >= 4 by FIRST
// APPEARANCE order of the identity; stable for the session
// (import SET_LINE_COLORS/SET_LINE_CASING from ./set-lines).
```

Rendering rules:
- `LiveView` renders inside the stage over the (already visible)
  provider video: a frame-coordinate wrapper sized by the live frame
  dims scaled to the displayed video box (same math as
  AnalysisView's overlay wrapper — read it), containing
  `TrackGhosts` + `LiveSetLines`, both `aria-hidden`.
- `TrackGhosts`: one element per track keyed by `trackId`.
  `locked` → full ghost (`ghostFaceSvg(reading)` + matrix3d, exactly
  the Overlay path — extract/reuse, don't duplicate: if extraction
  is needed, move the shared ghost-positioning into
  `src/ui/ghost-transform.ts` and use from both);
  `uncertain-locked` → ghost with the dashed treatment;
  `tentative` → cased outline (opacity ≥ 0.6 on a dark casing — the
  contrast floor is the CASING, not faintness);
  `reading` → outline + a `reading-shimmer` CSS animation.
  Transitions: `transition: transform 100ms linear` on the
  matrix3d carrier (the spec's decomposed fallback is recorded, not
  built — spot-check happens at phone smoke).
- `LiveSetLines`: triangles through member track centroids for
  every LiveSet, color/dash from the session color map, casing
  under core, selected identity = thicker (weight, never hue).
- Freshness cue: a small fixed dot (`.fresh-pulse`) that triggers a
  ~200ms CSS pulse on every `updateCount` change (key it by
  updateCount) and carries a `degraded` class (one step dimmer) when
  the ladder is below 768. `aria-hidden`.
- Hud in live phase: summary text per reveal (cards: "{n} cards
  read"; presence: presence.shown text; sets: "{k} sets" + chips by
  identity); the Live/Still toggle button (44pt); reveal segmented
  control as today.
- SrResults live variant: sr-only list of LOCKED tracks' readings
  (reuse `reading()`), membership suffix only in sets reveal.
- Spoiler parity AT THE APP BOUNDARY: below "sets", LiveView
  receives `liveSets=[]` and `selected=null`; presence mode passes
  only the boolean to PresenceBorder + Hud (reuse PresenceBorder
  with the DEBOUNCED `presence.shown`).
- Session wiring: when camera reaches `live` state AND screen is
  idle → construct driver (client from clientRef; capturer from
  Task 1; video from context) → `dispatch({type:"live-entered"})` →
  `driver.start()`. Updates dispatch `live-update-received` (with
  `Date.now()`); `onDegraded` dispatches `live-degraded`; `onStall`
  → `dispatch({type:"engine-failed", message:"The card reader
  stalled."})` (failure overlay; retry replaces Session; camera
  survives via provider). Driver stop+`live-left` on unmount and on
  mode toggle (Task 7 owns the toggle flow).

- [ ] **Steps:** set-colors TDD; components built against tsc +
  existing suites; extract-don't-duplicate the ghost transform; dev
  server smoke; full gates; commit in 2 logical commits ("Add live
  stage rendering", "Wire the live session into the app shell").

---

### Task 7: Feedback UI + FeedbackLog + export + mode toggle

**Files:**
- Create: `src/app/feedback-log.ts` (+ test),
  `src/ui/FeedbackSheet.tsx`, `src/ui/stage-coords.ts` (+ test)
- Modify: `src/ui/LiveView.tsx`, `src/ui/Hud.tsx`, `src/ui/App.tsx`,
  `src/ui/app.css`, `src/app/state.ts` (mark-related event if
  needed for announcements: `{ type: "mark-confirmed"; text:
  string }` appending a transient confirmation to the live screen's
  announcement — reducer holds `lastConfirmation: string | null`,
  cleared on next live-update)

**Interfaces:**

```ts
// stage-coords.ts — pure
export function domToFrame(
  point: { x: number; y: number },      // client coords
  stageRect: DOMRect,                   // wrapper getBoundingClientRect
  frameSize: { width: number; height: number },
): Point; // clamped to frame bounds
export const EDGE_NO_FIRE_PX = 24;      // grip margin, client px
export function inNoFireZone(
  point: { x: number; y: number },
  stageRect: DOMRect,
): boolean;
```

```ts
// feedback-log.ts — pure store
export interface FeedbackEntry {
  at: number;
  mark: Mark;
  outcome?: "roi-found";
}
export function createFeedbackLog(): {
  record(mark: Mark, at: number): void;
  noteRoiFound(near: Point, at: number): void; // most recent
    // unresolved missed-card within FACE radius gets outcome
  entries(): FeedbackEntry[];
  toJson(): string; // { marks: [...] } convertible to fixture labels
};
```

Interaction rules:
- Tap dispatch on the live stage: hit-test the RENDERED ghost
  elements via `document.elementsFromPoint` filtered to
  `[data-track-id]` (each ghost/outline carries the attribute and an
  expanded padding hit area ≥ 44pt) — what you see is what you tap
  (spec; D1 guidance: DOM→frame conversion is ours). Multiple hits →
  a small chooser listing readings. No hit → if in the no-fire zone,
  ignore; else open the empty-space sheet.
- Card sheet (bottom sheet over the running feed): the reading as
  words + three 44pt buttons — Correct / Wrong reading / Not a card.
  Action → `client.sendMark(...)` + `log.record(...)` + dispatch
  `mark-confirmed` ("Marked correct." etc.); dismiss on action or
  tap-away. Marks carry frame coords via `domToFrame` for positional
  types; face marks use the track's reading `cardKey`.
- Empty-space sheet: single explicit button "There's a card here"
  (the confirmation beat — never fires on the tap itself) + Cancel.
- ROI outcome inference: on each live-update, any track with
  `provenance === "roi-assist"` near an unresolved missed-card entry
  → `log.noteRoiFound`. Unresolved markers render as a small
  "couldn't read" glyph at the marked position; tapping one re-sends
  the missed-card mark (retry per tap).
- Export: a `.hud` overflow action "Export session log" — downloads
  `vsetp-feedback-{n}.json` via a Blob URL (revoked after click).
- Mode toggle (Hud): Live ⇄ Still, SERIALIZED: to Still →
  `await driver.stop()` (which awaits stopLive) → camera stays →
  CaptureView's shutter/picker active (screen back to idle). To
  Live → guard `screen.phase === "idle"` → start driver again.
  Disable the toggle button while a transition is in flight
  (in-flight flag in component state).
- FeedbackLog lives in App (above Session, beside the camera
  provider) so retry preserves it (spec).

- [ ] **Steps: TDD stage-coords (center map, corner clamp, no-fire
  zones) + feedback-log (record/outcome-inference radius/json
  shape); build sheets + wiring; announce test for mark
  confirmation; full gates; commit** "Add live feedback, session
  log, and mode toggle".

---

### Task 8: Deployed phone smoke (USER-RUN)

No implementer. After Tasks 1–7 land + final whole-plan review +
deploy: the user exercises on their phone —
1. Live mode: ambient overlay over a real spread; ghosts track
   smoothly (matrix3d interpolation spot-check — jumps = file the
   decomposed-transform fallback); locks converge; reveal ladder
   live; presence border debounced.
2. Feedback: tap a card → sheet; wrong/correct/not-a-card behave;
   missed-card assist on a deliberately-occluded card; export the
   log.
3. Mode toggle both directions, smooth, no permission re-prompt.
4. Stall/recovery: background the tab a while, return (screen may
   have slept — session should resume); thermal warmth EXPECTED.
5. Still mode regression: shutter, picker, reveal modes, offline.

Record observations (incl. battery/thermal) in the ledger.

---

## Self-review notes (author)

- Spec coverage: every "Live UI"/"Mode toggle"/"Errors & adaptation"
  spec item maps to Tasks 3–7; capture/liveness → Task 1;
  identity-selection prerequisite → Task 2; D1-final-review Issues
  1 (liveness hook, Task 1), 2 (suppression — recorded, no UI
  un-mark in v1), 5 (serialized toggles, Task 7) all addressed;
  wake lock + rVFC gate + no-cards + debounce + freshness cue +
  no-fire zones + 44pt all placed.
- Type consistency: `LiveFrameCapture`/`VideoLike` (T1) consumed by
  T5 deps; `LiveSet`/`live-update-received` (T3) consumed by T6;
  `createSetColorMap` (T6) self-contained; `domToFrame` (T7) pure.
- Deliberate deferrals: decomposed-transform fallback (spot-check
  first), buffer pooling (telemetry first), suppression expiry
  (tuning), worker routing tests (D1 recorded debt).
