# OpenCV sourcing: npm vs. hand-vendored fetch script

**Decision: NO-GO.** Stay with `bin/fetch-opencv.sh` vendoring the
official docs.opencv.org single-file build. Do not add an npm
dependency for OpenCV.js at this time.

## Context

Today `public/vendor/opencv-4.13.0.js` is fetched from
`https://docs.opencv.org/4.13.0/opencv.js` by `bin/fetch-opencv.sh`
and committed to git (sha256 recorded in commit 7667fd3). Both the
Node test loader (`src/vision/opencv/load-node.ts`) and the browser
worker (`src/vision/opencv/load-browser.ts`) consume this one file
through the shared `settleOpenCv` (`src/vision/opencv/runtime.ts`),
which deletes an own `then` property to defuse Emscripten's classic
self-resolving-thenable Module object before waiting on
`onRuntimeInitialized`.

The user asked (recorded in the Plan B->C progress ledger) whether an
npm-sourced artifact could replace the hand-rolled fetch script while
preserving the runtime shape: a separate, stably-named,
precache-able, progress-streamed asset. This task evaluates that
option against five binding criteria; ALL must hold for GO.

## Candidates examined

Searched the npm registry (`npm search opencv`, `npm view`) and GitHub
for anything positioned as an OpenCV.js distribution:

| Package | Version (latest) | Publisher | Notes |
|---|---|---|---|
| `@techstark/opencv-js` | 5.0.0-release.1 | ttt43ttt (single maintainer), GitHub-Actions OIDC publish | Most viable candidate; examined in depth below |
| `opencv-js-wasm` | 5.0.0-alpha | ttop324 | Alpha tag, thinner history |
| `@dusion/opencv-js` | 4.10.0-release.6 | dusion | Fork-of-a-fork, lags upstream |
| `opencv.js` | 1.2.1 | sajjadt (originally huningxin) | Stale (OpenCV 3.x era), abandoned |
| `opencv-wasm` | 4.3.0-10 | — | Stale, OpenCV 4.3 (2020) |
| `opencv-bindings` | 4.5.5 | — | Stale |

No package published under an OpenCV.org-controlled npm scope or
account exists (`@opencv/opencv-js` and bare `opencv-js` both 404).
OpenCV.org does not publish OpenCV.js to npm at all — the project's
own distribution channel is the docs.opencv.org build artifact we
already vendor. `@techstark/opencv-js` is the only actively
maintained, reasonably current candidate, so it is the one evaluated
against all five criteria.

## Criterion-by-criterion verdict (`@techstark/opencv-js@5.0.0-release.1`)

**1. Serves as a source only (build step copies one artifact into
`public/vendor/<name>-<version>.js`).** PASS (mechanically feasible).
The npm tarball's `dist/opencv.js` is a single 13.3 MB UMD file with
the wasm embedded — same shape as today's vendored file. A
`prebuild`/`postinstall` copy step is straightforward to write.

**2. Provenance: official, or verifiably built from official
source.** **FAIL.** Evidence:

- `TechStark/opencv-js` has a real, public build workflow
  (`.github/workflows/build-opencv-js.yml`) that checks out
  `opencv/opencv` at a named ref and builds it with OpenCV's own
  `platforms/js/build_js.py` via emsdk — this part is genuinely
  reproducible and inspectable.
- But that workflow is `workflow_dispatch`-only (not wired to
  publish), and the npm-publish workflow
  (`.github/workflows/npm-publish.yml`) does **not** consume its
  output. It runs `npm ci && npm publish --provenance` directly
  against whatever is checked into the repo's `dist/opencv.js`.
  npm's SLSA provenance attestation (confirmed present via
  `npm view @techstark/opencv-js --json` -> `dist.attestations`)
  proves "this tarball == this git commit, built by this GitHub
  Actions run." It does **not** prove that commit's
  `dist/opencv.js` is an unmodified official build.
- Checking that linkage by hand (`gh api
  .../commits?path=dist/opencv.js`) shows the 5.0.0 artifact was
  committed with the message "Replace dist/opencv.js with 5.0.0
  build (CI build #5, 13MB)" — plausibly traceable — **followed by a
  separate commit** ("Apply UMD compatibility patches to 5.x
  opencv.js") that hand-patches the already-built output: `this` ->
  `globalThis` in the UMD wrapper, and `Module = {}` -> `var Module =
  {}` for strict-mode/Webpack compatibility. This patch was authored
  and verified (38/38 Jest + compat tests) by an AI coding agent
  credited as co-author, reviewed only by the single maintainer.
- Net effect: the shipped artifact is a third-party rebuild with a
  publicly-inspectable but **not cryptographically verifiable**
  chain from `opencv/opencv` source to the file we'd vendor, plus a
  hand-applied post-build patch outside that build process entirely.
  This is exactly the "third-party rebuild without verifiable
  provenance" case the brief calls a FAIL, even though it is by a
  wide margin the most transparent third-party option available.
- Maintenance is real but thin: single npm maintainer, 748 GitHub
  stars, version cadence tracks upstream OpenCV releases with a
  several-month lag (4.11 Jun 2025, 4.12 Nov 2025, 5.0.0 Jun 2026).

**3. Single-threaded build available (GitHub Pages: no
COOP/COEP).** PASS. Confirmed by inspecting the actual published
artifact: `SharedArrayBuffer` does not appear in the file; the only
`pthread` occurrences are OpenCV's own TLS-abstraction error strings
compiled into every build (threaded or not), not evidence of a
`USE_PTHREADS` build. The build workflow's `threads` input also
defaults to `false`.

**4. Node-compatible for the ring-2 test loader.** Conditional
PASS-via-criterion-1 in principle (the vendored copy is what
`load-node` consumes either way) — but see criterion 5: correctness
here depends on a fix that hasn't landed.

**5. `settleOpenCv` native-thenable caveat (B2 deferral).**
**Triggers, confirmed.** Unpacked the actual tarball and read
`dist/opencv.js`: it is Emscripten's MODULARIZE pattern. The UMD
factory's tail is:

```js
if (runtimeInitialized) { moduleRtn = Module }
else { moduleRtn = new Promise((resolve, reject) => {
  readyPromiseResolve = resolve; readyPromiseReject = reject;
}) }
return moduleRtn
```

Calling the factory returns a **genuine native `Promise`**, not
Emscripten's classic self-resolving-thenable `Module` object that
`settleOpenCv` was written to defuse. `settleOpenCv`'s `delete
candidate.then` is a no-op on a native Promise (`then` lives on
`Promise.prototype`, not as an own property), so today's code would:
set a dead `onRuntimeInitialized` callback on the *Promise object*
(never invoked — the real Emscripten `Module` local is a different
object than the returned Promise), then `resolve(candidate)` a
native Promise from inside another Promise's executor, which adopts
the inner promise's eventual settlement. In practice this likely
*happens* to resolve correctly once wasm finishes loading (native
promise adoption, not the classic infinite-microtask hang the
existing comment warns about) — but that is an unverified, untested
code path standing on an accident of promise-adoption semantics, not
a design. Landing a native-thenable-safe branch in `settleOpenCv`
with unit tests, as the brief requires, is real, uncosted work — not
a rubber stamp.

## Decision

**NO-GO.** Criterion 2 fails outright, which alone is disqualifying
since all five criteria are binding. Criterion 5's cost (a real
`settleOpenCv` code path + tests, currently only exercised by
accident) compounds it. Keep `bin/fetch-opencv.sh` vendoring the
official docs.opencv.org artifact: it has unambiguous, single-source
provenance (OpenCV.org's own build, at a URL versioned by OpenCV
itself), and the runtime shape the user wants (separate,
stably-named, precache-able, streamed-with-progress vendored file) is
already exactly what we have.

## Trigger conditions to reopen

- OpenCV.org begins publishing an official OpenCV.js build to npm
  under its own account/org.
- `@techstark/opencv-js` (or an equivalent) publishes build
  provenance that cryptographically ties the shipped `dist/opencv.js`
  bytes to an unmodified `opencv/opencv` build — e.g. SLSA
  provenance/attestation on the *build-opencv-js* workflow itself
  (not just the npm-publish step), with any compatibility patches
  applied as reviewed, versioned patch files rather than
  silently-recommitted output.
- The team decides the provenance risk is acceptable to take on
  explicitly (a product/security call, not an engineering default) —
  in which case criterion 5's `settleOpenCv` native-thenable fix must
  land with tests *before* the swap, per the brief.
