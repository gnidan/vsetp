# Live Viewfinder (Plan D) — Design

2026-07-06 · Addendum to
`2026-07-02-set-detector-design.md`, whose live-mode deferrals this
resolves. Base state: Plans A–C shipped (deployed PWA at
gnidan.github.io/vsetp; still-capture flow; graduated reveal modes;
fixture-verified pipeline).

## Goal

Full ambient overlay: hold the phone over the table and every card
wears its ghost continuously; reveal modes, set lines, and per-card
feedback all work live. Still capture remains as a mode.

## Decisions (from brainstorm)

- Experience: full ambient overlay (not framing-assist).
- Reading stability: lock-after-consensus (3 consecutive agreeing
  classifications); locked readings never flicker.
- Persistence: feedback marks key to card FACES (`CardKey`, unique
  per deck) so they survive tracking loss; positional marks
  (not-a-card, missed-card) key to table position.
- Budget: mid-tier phone, ~10 overlay updates/sec; positions
  interpolated between updates for smoothness.
- Feedback UX: tap → action sheet, feed keeps running.
- Tracker lives IN THE WORKER (it holds the frames; classification
  scheduling needs the pixels).
- Live is primary once the camera is enabled; Still is the
  quality/keepsake mode and the only mode without a camera.

## Protocol additions (`WorkerProtocol` map — typed guard sets catch
omissions at compile time)

```
live-start { }                     -> live-ready
live-frame { frameId, frame }      -> live-update { frameId, tracks }
                                    | dropped { frameId }
live-feedback { mark }             -> (no reply; folded into next
                                       live-update)
live-stop { }                      -> live-stopped
```

- Live frames are downscaled AT CAPTURE to `LIVE_FRAME_MAX_DIMENSION
  = 768` (long edge) through the existing normalization path (same
  coordinate-space guarantee); pixels transferred as today.
- Newest-wins mailbox semantics apply unchanged to `live-frame`.
- `Track { trackId: TrackId; quad: Quad; state: TrackState;
  reading?: Card; confidence?: AttributeConfidence }` — plain
  structured-clone data, no pixels. `TrackId` is a new branded
  number, session-scoped.
- `Mark = { type: "correct"; key: CardKey } | { type: "wrong"; key:
  CardKey } | { type: "not-a-card"; at: Point } | { type:
  "missed-card"; at: Point }` (points in live-frame coordinates).
- Per-stage `timings` ride in each `live-update` (live perf
  telemetry for free).

## Tracker (pure module; worker-hosted)

Track table advanced per frame in three phases — all plain data +
pure functions (`advanceTracks(table, detections, marks, budget) →
{table', toClassify}`), unit-testable with scripted quad sequences:

1. **Match:** greedy nearest-centroid assignment (IoU tiebreak)
   between new detections and existing tracks. Cards are stationary
   (the camera moves), so inter-frame deltas are small at 10fps.
   Unmatched detections spawn `tentative` tracks; unmatched tracks
   age.
2. **Age & retire:** missing `TRACK_RETIRE_FRAMES = 8` frames →
   retire. Pan-away clears the table; pan-back re-forms tracks, and
   readings reattach instantly via the session-level **face memory**
   (`Map<CardKey, Card + lock>`) without re-consensus.
3. **Classify & lock:** per frame the worker classifies the K oldest
   unlocked tracks (K = remaining frame budget, typically 1–2).
   `CONSENSUS_TO_LOCK = 3` consecutive agreeing reads → `locked`.
   Unlock triggers: a `wrong` mark (fresh consensus round), or the
   track's quad area growing > 2x (camera moved closer; better
   pixels — re-verify).

Track states: `tentative` → `reading` → `locked`; plus `suppressed`
(from not-a-card marks: a table-position patch hides re-detections
landing in it).

**Missed-card assist:** a `missed-card` mark queues a focused second
look — crop an ROI around the mark from the next frame, run detection
there at full ROI resolution with progressively relaxed gates
(implemented as an ROI variant of the existing strategy ladder;
relaxed thresholds are acceptable because the human asserted a card
is present). Found → normal track. Not found → visible "couldn't
read this one" marker. Either way the mark exports as
false-negative tuning data.

Automatic non-card elimination is inherited: the zero-symbol-region
drop applies to every live classification, so face-down cards and
blank rectangles never become readable tracks.

## Feedback store & export

Main-thread session `FeedbackLog`: `{ correct, wrong, notACard,
missedCard }` with timestamps; marks go to the worker AND the log.
Export: a settings-corner action downloading JSON convertible to the
fixture-label format (`key` + `near`) — live sessions at real tables
become tuning-corpus candidates. Session-scoped only (no storage
backend in v1).

## Live UI

- Overlay reuses the entire still pipeline's rendering: matrix3d
  ghosts, per-symbol cyan halos, dashed-uncertain; positions
  interpolate (~100ms CSS ease) between updates.
- Track visuals: `tentative` = faint outline; `reading` = outline +
  progress shimmer; `locked` = full ghost. Suppressed zones and
  missed-card markers have distinct minimal glyphs.
- **Reveal modes work identically live** with the same spoiler
  parity (App prunes set data below "sets" mode). Sets computed on
  the main thread per update over LOCKED tracks only.
- **Stable set-line colors:** a set's identity = the sorted triple
  of member CardKeys; colors assign by first appearance of that
  identity in the session (small map). No flicker across frames,
  re-detections, or pans. (Closes the Plan C final-review trap:
  colors must never key to triples-array index in live mode.)
- Tap dispatch: hit-test tracks (expanded regions) → action sheet
  (reading + Correct / Wrong / Not a card); empty space → "There's a
  card here" sheet. Sheet floats over the running feed.
- A11y: the persistent live region announces state transitions
  (throttled — never per frame): mode changes, lock milestones
  ("12 cards read"), set presence changes per reveal mode, feedback
  confirmations. SrResults reflects locked tracks. Announcement
  throttling is a hard requirement.
- **Failure panel overlays a still-mounted stage** (Plan C final
  review requirement): worker death shows retry OVER the frozen
  viewfinder; retry creates a fresh client/worker and resumes; the
  camera stream and FeedbackLog live above Session and survive.

## Mode toggle

HUD control: **Live / Still**. Camera enabled → Live is primary.
Still = today's flow unchanged (3072px quality path; the only mode
without a camera). Live→Still pauses the loop (`live-stop`), keeps
the stream; Still→Live resumes. Same stage, both fullscreen, no
remounts.

## Errors & adaptation

- Budget overruns degrade smoothly by construction (newest-wins
  drops frames → lower update rate). Sustained < 4 updates/sec →
  worker steps detection resolution down one rung (768 → 640),
  reported via timings. No user-facing knob.
- Live liveness: the 30s analyze watchdog is replaced for live
  frames by a 5s no-update-while-sending check → treat as worker
  death → failure overlay.
- Hand-sweep chaos: tracks age out and re-form in < 1s; face memory
  snaps readings back. Explicitly tested.

## Per-frame-safety sweep (Plan C final-review requirements)

Before the live loop lands, these per-capture assumptions get gated:
the install success-counter counts still-mode captures only; the
displayUrl revoke effect is still-mode only (live frames use no blob
URLs); `announcementFor` output is throttled per above. The
frame-session/handle CardVision variant remains sanctioned but is
NOT required for v1 live (768px frames keep per-call ingest cheap);
revisit only if measured timings demand it.

## Testing

1. Tracker/consensus/face-memory/set-identity-colors: pure unit
   tests with scripted sequences (drift, occlusion, swap-in-place,
   pan-away-return, hand-sweep).
2. Frame-loop integration: `renderSequence` in the synthetic
   renderer — a scripted camera path (per-frame translate/scale)
   over a fixed tableau — driven through the REAL worker pipeline
   logic in Node; asserts track continuity, lock convergence, and
   no-flicker invariants.
3. Protocol: guard/typing tests as established.
4. Acceptance: user's phone at a real table; the FeedbackLog export
   is the evidence artifact.

## Out of scope (recorded, not designed)

Feedback persistence across sessions; multi-table/multi-deck
sessions; ML classification; the frame-session CardVision variant
(unless timings force it); background/PiP operation.
