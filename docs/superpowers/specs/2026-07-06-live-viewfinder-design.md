# Live Viewfinder (Plan D) — Design

2026-07-06 · Rev 2 (incorporates four-persona audit: CV/tracking,
mobile platform, architecture, UX/a11y). Addendum to
`2026-07-02-set-detector-design.md`. Base state: Plans A–C shipped.

## Goal

Full ambient overlay: hold the phone over the table and every card
wears its ghost continuously; reveal modes, set lines, and per-card
feedback all work live. Still capture remains as a mode.

## Core decisions (brainstorm + audit-hardened)

- Experience: full ambient overlay.
- Reading stability: lock-after-consensus with an escape hatch (see
  Tracker); locked readings never flicker but ARE periodically
  re-verified (audit: silent-swap blocker).
- Persistence: feedback marks key to card FACES (`CardKey`);
  positional marks (not-a-card, missed-card) key to table position.
- Budget: mid-tier phone, ~10 overlay updates/sec BEST-EFFORT (not
  guaranteed); interpolated positions between updates.
- Feedback UX: tap → action sheet over the running feed; hit-tests
  target RENDERED positions (see Feedback).
- Tracker lives in the worker.
- Live is primary once the camera is enabled; Still is the quality
  mode and the only mode without a camera.

## Platform reality (binding constraints)

- Frame drive: `requestVideoFrameCallback` where available
  (iOS Safari ≥ 15.4); feature-gated with an rAF/setInterval-paced
  fallback below that. 10fps is a ceiling under good conditions;
  Low Power Mode and thermal throttling will reduce it — the design
  degrades smoothly rather than promising a floor.
- **Thermal/battery expectation, stated plainly:** camera + sustained
  WASM detection + animated overlay is a heavy workload. Visible
  device warmth and meaningful battery draw over a multi-minute
  session on mid-tier hardware are EXPECTED, not regressions. The
  adaptation ladder (below) manages it; it does not eliminate it.
- Wake lock: request `navigator.wakeLock` opportunistically
  (iOS ≥ 16.4 in-browser; broken in INSTALLED iOS web apps until
  18.4 — WebKit bug 254545). Screen-sleep mid-session is an accepted
  failure mode on affected devices: the session resumes on wake
  (tracks re-form via face memory); no fallback hacks.
- Carried over from the base spec: `getUserMedia` does not work in
  installed/home-screen iOS web apps (WebKit bug 185448) — Live mode
  is scoped to desktop/Android/iOS-in-browser; installed-iOS users
  get Still mode via the picker.
- `matrix3d` CSS transitions interpolate via matrix decomposition,
  which diverges across engines (CSSWG #3230/#3713). Plan: spot-check
  on iOS Safari during the first live milestone; if interpolation
  jumps, fall back to decomposed translate/rotate/scale transitions
  computed from the homography. The fallback is a rendering detail
  behind the same Track→style function.

## Live capture path (main thread)

- NEW `captureLiveFrame(video): Frame` — shares `clampedSize` and the
  draw/`getImageData` core with `normalize()` but produces PIXELS
  ONLY: no `toBlob`, no object URL, ever. (`normalize()` splits into
  a shared pixel core + a display-artifact wrapper used by Still.)
- One persistent module-scoped capture canvas, reused across the
  session, resized only when video dimensions change. No per-frame
  canvas/context allocation.
- Frames are downscaled at capture to `LIVE_FRAME_MAX_DIMENSION =
  768` (long edge). Each frame's buffer is transferred (neutered);
  allocation churn is bounded by frame pacing (~2.3MB × ≤10/s) and
  accepted for v1 — IF main-thread telemetry shows GC jank, a small
  rotating buffer pool is the designated fix (buffers returned via
  live-update round-trip). Decision deferred on measurement, not
  assumed.
- Main-thread telemetry: capture cost (draw + read + post) is
  sampled and attached to outgoing frames, so `timings` in each
  live-update covers BOTH sides of the boundary.
- `mintFrameId()` is shared with Still (single monotonic counter;
  globally unique ids).

## Protocol additions (typed `WorkerProtocol` map)

```
live-start { }                  -> live-ready
live-frame { frameId, frame }   -> live-update { frameId, tracks,
                                                 timings }
                                 | dropped { frameId }
live-feedback { mark }          -> mark-ack { markId }
live-stop { }                   -> live-stopped
```

- Correlation model is unchanged: every response correlates 1:1 to a
  request by frameId/markId (live-update is NOT unsolicited).
- **Live mailbox variant** (the existing analyze mailbox is not
  reused as-is): a frame slot with newest-wins semantics PLUS a
  separate never-dropped marks queue — displacing a waiting frame
  never discards marks. Marks are drained into the tracker at the
  start of each processed frame.
- **Still/live handshake:** `analyze` and `live-frame` are never
  concurrently in flight. Mode switch to Still sends `live-stop` and
  awaits `live-stopped` before any `analyze` may be posted (client-
  enforced, same style as init gating). Worker-side, a live-session
  flag rejects `analyze` during a session as a protocol error.
- `Track { trackId: TrackId; quad: Quad; state: TrackState;
  reading?: Card; confidence?: AttributeConfidence; provenance?:
  "roi-assist" }` — plain data, no pixels. `TrackId` = branded
  number, session-scoped, stable for the track's lifetime.

## State model (main thread)

New reducer surface (extends src/app/state.ts):

- `Screen` gains `{ phase: "live"; tracks: Track[]; liveSets:
  LiveSet[]; freshAt: number }` where `LiveSet = { id: SetIdentity;
  trackIds: TrackId[] }` and `SetIdentity` = the sorted member
  CardKeys joined (branded string) — the stable identity used for
  color assignment AND selection.
- New events: `live-entered`, `live-update-received { tracks }`,
  `live-left`, `mark-submitted { mark }`, `mode-toggled`.
- **`selected` becomes identity-keyed everywhere:** results/live
  selection stores a `SetIdentity`, not a triples index (fixing the
  latent index-identity bug in Still mode too). Chips and SetLines
  resolve identity → current members per update; a selected set that
  disappears clears selection.
- Set computation per live-update runs over LOCKED tracks only, on
  the main thread, via the live solver projection (below).

## Track → solver/render projection

The still pipeline's `CardId`-typed types are NOT reused for live
(audit: per-frame CardIds would churn React keys and break
interpolation). Instead:

- `makeTableau`/`findSets` become generic over a branded id
  (`Tableau<Id>`; `CardId` and `TrackId` both satisfy it) — a
  type-level generalization with zero runtime change, verified by
  the existing exhaustive tests.
- Live rendering keys ghosts/outlines by `trackId` (stable for the
  track's life). The Overlay component gains a track-driven variant
  sharing the ghost/outline/style internals; Still keeps its
  `FrameAnalysis` path unchanged.
- Set-line colors assign by first-session-appearance of
  `SetIdentity` (small map), never by array position.

## Tracker (pure module; worker-hosted)

`advanceTracks(table, detections, marks, budget) → { table',
toClassify, roiRequests }` — pure, scripted-sequence-testable.

**Matching (audit-revised):** IoU-with-predicted-quad is PRIMARY;
centroid distance is the fallback only when nothing overlaps (e.g.
re-forming after a pan). A max-displacement / min-IoU gate rejects
force-matches: a detection failing the gate spawns `tentative`
rather than being adopted. Locked tracks claim their matches before
`reading`/`tentative` tracks compete. Match confidence below a
threshold on a LOCKED track triggers re-verification (see below)
instead of silent carry-over.

**Aging:** missing `TRACK_RETIRE_FRAMES = 8` frames → retire.
`reading`-state tracks retiring preserve their partial consensus
tally keyed by position patch for `CONSENSUS_GRACE_MS = 3000` — a
brief hand-occlusion resumes counting instead of restarting.

**Classification & locking:**
- Per frame, classify the K oldest unlocked tracks (K from remaining
  budget, typically 1–2).
- `CONSENSUS_TO_LOCK = 3` consecutive agreeing reads → `locked`.
- **Escape hatch (audit):** after `MAX_CONSENSUS_ATTEMPTS = 7`
  classifications without 3-consecutive agreement, the track becomes
  `uncertain-locked`: plurality reading, dashed/uncertain treatment,
  retry cadence dropped to ~2s so it stops starving the budget.
  Honest uncertainty carries into live mode.
- Acceptance bound: p50 time-to-all-locked ≤ 6s for a static 20-card
  tableau on the reference device (measured via timings).

**Re-verification of locked tracks (audit blocker fix):**
- Spare classify budget (frames where fewer than K unlocked tracks
  exist) re-confirms locked tracks round-robin, each roughly every
  2–3s. A re-read disagreeing with the lock demotes the track to
  `reading` (consensus restarts) — a silent swap self-heals within a
  few seconds.
- Unlock triggers: `wrong` mark; sustained quad-area growth > 2x
  over ≥ 2 consecutive frames (hysteresis — single-frame jitter
  cannot trip it); low-confidence match / positional jump (above).

**Face memory (audit-hardened):**
- `Map<CardKey, { card, lastSeenAt: Point }>` of LOCKED readings.
- Reattachment VALIDATES, never creates: a re-formed track whose
  first read matches an existing entry AND is spatially plausible
  (near `lastSeenAt`, generous radius) relocks immediately. A key
  with no entry — or an implausible position — takes the normal
  consensus path. A key currently claimed by another live track is
  never reassigned (no teleporting locks).
- `wrong` marks EVICT the map entry for that key in addition to
  unlocking the track.

**Marks in the tracker:** `not-a-card` creates a suppression patch
(table-position; re-detections inside stay hidden). `missed-card`
queues an ROI request: crop around the mark from the next frame,
run detection at full ROI resolution with progressively relaxed
gates (ROI variant of the strategy ladder). Found → track with
`provenance: "roi-assist"` (telemetry/tuning flag; consensus rules
apply unchanged). Not found → the marker renders as "couldn't read
this one"; a repeat tap on the marker retries once per tap (not
one-shot-forever). All marks and outcomes land in the FeedbackLog.

## Feedback store & export

Main-thread session `FeedbackLog` with timestamps; marks flow to the
worker AND the log; ROI outcomes flow back into the log. Export: a
settings action downloading JSON convertible to the fixture-label
format. Session-scoped only.

**Interaction (audit-hardened):**
- Hit-testing runs against RENDERED positions (DOM bounding rects of
  the interpolated ghosts), never the raw track table — what you see
  is what you tap, even mid-pan. Expanded hit regions; overlapping
  candidates get a small chooser.
- Empty-space taps (missed-card) require a confirmation beat — the
  sheet appears with an explicit "There's a card here" button rather
  than firing on the tap itself — so grip-grazes can't pollute the
  export corpus. A no-fire margin hugs the screen edges near
  one-handed grip zones.
- Touch targets ≥ 44×44 pt; HUD honors safe-area insets. (Layout
  details are implementation's, these two floors are binding.)

## Live UI

- Ghosts/outlines/dashed-uncertain reuse the existing visual system
  via the track-keyed Overlay variant; positions interpolate ~100ms
  between updates (fallback plan per Platform reality).
- Track visuals: `tentative` = outline; `reading` = outline +
  progress shimmer; `locked` = full ghost; `uncertain-locked` =
  ghost + dashed. Tentative/reading indicators meet the SAME
  contrast/CVD standard as the set-line palette (minimum 3:1 against
  expected table backgrounds; the "faint" treatment is opacity on a
  cased outline, not low contrast).
- **Freshness cue:** a subtle pulse tied to live-update RECEIPT (not
  content change) distinguishes "stable scene" from "stalled
  pipeline" for sighted users; it also dims one step when the
  adaptation ladder has downshifted (degraded mode is visible, not
  secret).
- Reveal modes work identically live, same spoiler parity (App
  prunes set data below "sets" mode). Set presence (presence mode)
  is DEBOUNCED as a derived signal: presence/absence must hold for
  `PRESENCE_DEBOUNCE_UPDATES = 5` consecutive updates before the
  border/text/announcement change — re-verification blips cannot
  flap it.
- **A11y (audit-hardened):**
  - Announcements are event-driven and throttled: mode changes, lock
    milestones ("12 cards read"), DEBOUNCED set-presence changes,
    feedback confirmations.
  - **Silence is disambiguated:** after `NO_CARDS_GRACE_MS = 4000`
    of an active session with zero tracks, announce "No cards in
    view" (repeated at a slow cadence while true) — a blind user can
    aim by audio. Stall (no updates while frames send) announces
    "Camera analysis stalled" before the failure path. These make
    Live genuinely usable non-visually rather than nominally.
  - SrResults reflects locked tracks; per-frame updates never
    announce.
- **Failure overlay (restructure REQUIRED, made explicit):** camera
  stream + `<video>` ownership hoists ABOVE Session (the C5
  live-region treatment): a `CameraProvider` at App level owns the
  stream/lifecycle; CaptureView and the live stage consume it. The
  failure panel then overlays the still-mounted stage; retry
  replaces Session (fresh client/worker) while the camera, mode,
  reveal, and FeedbackLog persist. This resolves the Plan C review's
  requirement #1 structurally.

## Mode toggle

HUD control: **Live / Still**, both fullscreen, same stage, no
remounts (camera ownership per above). Live→Still: `live-stop`,
await `live-stopped`, keep the stream, Still shutter available.
Still→Live: `live-start` resumes. Still remains today's 3072px
quality path and the only camera-less mode. The install
success-counter and displayUrl revoke effect are Still-only
(mechanism: they key off the Still capture flow, which live frames
never enter — `captureLiveFrame` produces no display artifacts to
revoke and no `Capture` objects to count).

## Errors & adaptation

- Adaptation ladder: sustained (≥ 3s) update rate < 4/s → step
  detection resolution down one rung (768 → 640 → 512 floor).
  Upshift only after 30s sustained comfortably above 6/s (wide
  dead-band; no flapping). At the 512 floor, stay there — the
  freshness cue shows degraded state; no further action.
- Watchdog reconciliation: the live death check is "no live-update
  AND no dropped for 5s while frames are being sent", evaluated
  AFTER the adaptation window logic, and any worker message resets
  it — a slow-but-alive worker downshifts; only true silence dies.
  Still-mode analyze keeps its 30s watchdog.
- Worker death → failure overlay over the mounted stage; retry
  resumes the session; face memory is worker-side and lost on death
  (tracks re-lock via consensus; accepted).
- Hand-sweep chaos: tracks age out and re-form < 1s; face memory +
  consensus-grace restore readings quickly. Explicitly tested.

## Testing

1. Tracker pure tests, scripted sequences: drift, occlusion,
   swap-in-place (MUST self-heal via re-verification within the
   re-verify cadence), pan-away-return, hand-sweep, oscillating
   marginal card → `uncertain-locked`, face-memory poisoning attempt
   (wrong single read post-occlusion must NOT relock), spatial
   implausibility rejection, mark eviction.
2. Consensus/grace/budget arithmetic: time-to-all-locked bound
   verified against scripted 20-card sequences.
3. Live solver projection: generic tableau typing; SetIdentity
   stability across reordered updates; identity-keyed selection.
4. Protocol: guard/typing tests; mailbox variant (marks survive
   frame displacement); still/live handshake.
5. Frame-loop integration: `renderSequence` — scripted camera path
   over a fixed tableau through the real worker pipeline in Node —
   asserting track continuity, lock convergence, no-flicker, and
   re-verification self-healing.
6. Acceptance: user's phone at a real table; FeedbackLog export as
   evidence; thermal/battery observations recorded (expected, per
   Platform reality).

## Out of scope (recorded)

Cross-session feedback persistence; multi-table sessions; ML
classification; frame-session CardVision variant (revisit only if
main-thread telemetry demands); background/PiP; buffer pooling
(designated fix if telemetry shows GC jank, not built by default).
