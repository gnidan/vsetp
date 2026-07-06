# Set Detector Plan C: PWA + Deploy + Camera-First UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app deployed at a real HTTPS URL, installable and
offline-capable, with a fullscreen camera-first interface — ready for
phone use at a game table and for Plan D (live viewfinder) on top.

**Architecture:** No pipeline or protocol changes. GitHub Actions gains
a Pages deploy job gated on green CI. `vite-plugin-pwa` provides the
manifest + service worker (with the Workbox size-cap fix that makes the
10.9MB OpenCV artifact actually precache). The UI is restructured into
a fullscreen stage (viewfinder / captured photo / overlays) with a
floating HUD; the accessible results surface becomes a persistent
ARIA-live region + visually-hidden card list.

**Tech Stack:** Existing stack + `vite-plugin-pwa` (dev dependency).
Deploy: GitHub Pages via Actions (`gnidan/vsetp`, public, base
`/vsetp/` already configured).

**Requirements sources:** spec §PWA & deployment, §UI/app flow,
§Accessibility, §Error handling; Plan B final-review requirements
(recorded in `.superpowers/sdd/progress.md`, "Plan C requirements"
line); user UX direction: fullscreen PWA feel, minimal chrome, no
visible card list.

## Global Constraints

- 80-character lines; double quotes; plain data + free functions;
  TDD for pure logic; components gated by `npx tsc -b`; `npm test`
  (191+ incl. real-photo fixtures) and `npm run build` green at every
  commit; prettier-clean.
- **A11y invariants (hard, from spec + final review):** a DOM results
  surface always exists — a PERSISTENT `aria-live="polite"` region
  (mounted once, text mutated, never remounted) plus a
  visually-hidden (`sr-only`) card list with readings as words
  ("2 striped red ovals"). The visual overlay stays `aria-hidden` and
  is never the sole representation. Uncertainty = line style (dashed),
  never hue. Highlight cyan `#00e5ff` stays distinct from card inks.
- **Client lifecycle invariants:** client-per-mount stays (StrictMode);
  `dispose()` poisons permanently by design; every analyze error path
  must ignore `DisposedError`.
- **Capture stays single-point:** all frames route through
  `src/app/capture.ts` `normalize()` — one canvas, one coordinate
  space. The fullscreen redesign must not fork it.
- Protocol changes (if any) go in the `WorkerProtocol` map first — the
  typed guard sets now fail compilation when forgotten.
- Service worker: `maximumFileSizeToCacheInBytes` MUST be ≥ 12 MiB or
  offline is fiction (Workbox default 2 MiB silently excludes the
  10,964,323-byte artifact). Vendor asset filename stays
  content-versioned (`opencv-4.13.0.js`) — never bundler-hashed.
- Dev mode: service worker disabled (`devOptions.enabled: false`,
  the default — keep it).
- Deployed URL shape: `https://gnidan.github.io/vsetp/`.

---

### Task 1: GitHub Pages deploy workflow

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: every push to `main` with green tests deploys `dist/` to
  `https://gnidan.github.io/vsetp/`. Later tasks (and the user's phone)
  consume the URL.
- One-time repo setting (coordinator/user, NOT the implementer): Pages
  must be set to "GitHub Actions" source —
  `gh api -X POST repos/gnidan/vsetp/pages -f build_type=workflow`
  (409 = already enabled; fine).

- [ ] **Step 1: Extend the workflow**

Replace `.github/workflows/ci.yml` with:

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
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
      - uses: actions/upload-pages-artifact@v3
        if: github.ref == 'refs/heads/main'
        with:
          path: dist
  deploy:
    if: github.ref == 'refs/heads/main'
    needs: test
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Verify locally, commit, verify remotely**

Run: `npm test && npm run build` — green (workflow edits can't break
them, but the commit gate applies always).

```bash
git add .github/workflows/ci.yml
git commit -m "Deploy to GitHub Pages on green main"
git push
```

Then: `gh run watch --exit-status` (or poll `gh run list`) until the
`test` and `deploy` jobs both succeed. Confirm
`curl -sI https://gnidan.github.io/vsetp/ | head -1` returns 200, and
`curl -sI https://gnidan.github.io/vsetp/vendor/opencv-4.13.0.js |
grep -i content-length` shows ~10964323. If Pages isn't enabled yet,
report BLOCKED with the exact `gh api` command for the coordinator —
do not change repo settings yourself.

---

### Task 2: PWA plumbing (manifest, icons, service worker)

**Files:**
- Create: `bin/make-icons.ts`, `public/icons/` (generated PNGs,
  committed), `public/icons/icon.svg`
- Modify: `vite.config.ts`, `index.html`, `package.json` (dev dep)

**Interfaces:**
- Produces: `npm run build` emits `manifest.webmanifest` + `sw.js`
  with the FULL build precached (including the 10.9MB vendor
  artifact); the site is installable; repeat visits after first load
  work offline.
- Consumes: nothing new from other tasks.

- [ ] **Step 1: Icon source + generator**

`public/icons/icon.svg` — a minimal card motif (rounded card with the
three inks as diamond/oval/squiggle dots), hand-written:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#12233a"/>
  <rect x="96" y="64" width="320" height="384" rx="40"
    fill="#fdfdf8"/>
  <polygon points="256,120 328,192 256,264 184,192"
    fill="#d43a2f"/>
  <rect x="196" y="296" width="120" height="56" rx="28"
    fill="#3fa652"/>
  <path d="M196 400 c30 -28 90 28 120 0" stroke="#6a2c91"
    stroke-width="28" fill="none" stroke-linecap="round"/>
</svg>
```

`bin/make-icons.ts`:

```ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const root = join(import.meta.dirname, "..", "public", "icons");
const source = join(root, "icon.svg");

async function emit(size: number, name: string): Promise<void> {
  await sharp(source).resize(size, size).png().toFile(join(root, name));
  console.log(`wrote icons/${name}`);
}

await mkdir(root, { recursive: true });
await emit(192, "icon-192.png");
await emit(512, "icon-512.png");
// maskable: same art, safe-zone padding via extend
await sharp(source)
  .resize(410, 410)
  .extend({
    top: 51,
    bottom: 51,
    left: 51,
    right: 51,
    background: "#12233a",
  })
  .png()
  .toFile(join(root, "icon-512-maskable.png"));
console.log("wrote icons/icon-512-maskable.png");
```

Run: `npx tsx bin/make-icons.ts` — three PNGs appear; commit them
(icons are build inputs, not outputs).

- [ ] **Step 2: vite-plugin-pwa**

```bash
npm install -D vite-plugin-pwa
```

`vite.config.ts` — add the plugin:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/vsetp/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // the entire point of offline support is the 10.9MB OpenCV
      // artifact; Workbox's 2MiB default silently excludes it
      workbox: {
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
      },
      includeAssets: ["vendor/opencv-4.13.0.js"],
      manifest: {
        name: "vsetp — Set table reader",
        short_name: "vsetp",
        description:
          "Point your camera at a Set spread; find the sets.",
        display: "standalone",
        orientation: "portrait-primary",
        background_color: "#12233a",
        theme_color: "#12233a",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192",
            type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512",
            type: "image/png" },
          { src: "icons/icon-512-maskable.png", sizes: "512x512",
            type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
  },
});
```

`index.html` `<head>` additions:

```html
    <meta name="theme-color" content="#12233a" />
    <link rel="icon" href="/vsetp/icons/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/vsetp/icons/icon-192.png" />
```

- [ ] **Step 3: Verify the precache actually contains the artifact**

Run: `npm run build`, then:

```bash
grep -c "opencv-4.13.0.js" dist/sw.js
```

Expected: ≥ 1 (the precache manifest lists it). If 0, the size cap or
glob is wrong — fix before committing; this is THE check that makes
offline real. Also `ls dist/manifest.webmanifest` exists and
`npm test` stays green (plugin must not disturb vitest).

- [ ] **Step 4: Commit and verify deployed**

```bash
git add -A bin/make-icons.ts public/icons vite.config.ts index.html \
  package.json package-lock.json
git commit -m "Add PWA manifest, icons, and offline service worker"
git push
```

After deploy: `curl -s https://gnidan.github.io/vsetp/manifest.webmanifest | head -3`
returns JSON.

---

### Task 3: Fullscreen shell, persistent live region, sr-only results

**Files:**
- Create: `src/ui/announce.ts`, `src/ui/announce.test.ts`,
  `src/ui/readings.ts`, `src/ui/readings.test.ts`,
  `src/ui/SrResults.tsx`, `src/ui/Hud.tsx`
- Modify: `src/ui/App.tsx`, `src/ui/AnalysisView.tsx` (fills the
  stage), `src/ui/app.css` (rewrite), `index.html` (viewport-fit)
- Delete: `src/ui/ResultsPanel.tsx` (visual card list removed by user
  direction; its SEMANTICS move to SrResults + the live region)

**Interfaces:**
- Consumes: `AppState`/`Screen` (src/app/state.ts, unchanged),
  `edgeNotice` (src/app/guidance.ts), `FrameAnalysis`, `SetTriple`.
- Produces:
  - `announcementFor(state: AppState): string` — PURE selector that
    turns app state into the live-region text; unit-tested. Examples:
    engine loading → `"Loading card reader… 42%"`; analyzing →
    `"Analyzing…"`; results → `"2 sets found. 12 cards read."` (+
    edge notice appended when present); idle+notice → the notice;
    engine failed → the failure copy.
  - `reading(card: DetectedCard): string` — moved from the old
    ResultsPanel verbatim ("3 striped purple ovals" word order:
    count, fill, color, shape, plural s) into `src/ui/readings.ts`,
    exported + tested.
  - `<SrResults analysis triples selected />` — visually-hidden
    (`className="sr-only"`) ordered list of `reading(...)` strings,
    marking set membership textually (" — in the highlighted set").
  - `<Hud />` — the ONLY visible results chrome: one floating bottom
    bar with the summary line, set chips (only when
    `triples.length > 1`), Retake and Re-analyze buttons.
- **A11y wiring (the load-bearing part):** `App` renders ONE
  `<div aria-live="polite" role="status" className="sr-only">` at the
  top level that is NEVER unmounted across phases; its text content is
  `announcementFor(state)`. This satisfies the final-review Important
  (fresh-mounted live regions often never announce).

- [ ] **Step 1: Write failing tests for the pure pieces**

`src/ui/readings.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { DetectedCard } from "../model";
import { cardId } from "../model";
import { reading } from "./readings";

function card(overrides: Partial<DetectedCard["card"]>): DetectedCard {
  return {
    id: cardId(0),
    quad: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    card: {
      count: 2,
      color: "red",
      shape: "oval",
      fill: "striped",
      ...overrides,
    },
    confidence: { count: 1, color: 1, shape: 1, fill: 1 },
  };
}

describe("reading", () => {
  test("words in count-fill-color-shape order, pluralized", () => {
    expect(reading(card({}))).toBe("2 striped red ovals");
  });
  test("singular for count 1", () => {
    expect(reading(card({ count: 1, shape: "diamond" }))).toBe(
      "1 striped red diamond",
    );
  });
});
```

`src/ui/announce.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { AppState } from "../app/state";
import { initialState } from "../app/state";
import { announcementFor } from "./announce";

function withEngine(engine: AppState["engine"]): AppState {
  return { ...initialState(), engine };
}

describe("announcementFor", () => {
  test("engine loading with total reports percent", () => {
    expect(
      announcementFor(
        withEngine({ status: "loading", loaded: 42, total: 100 }),
      ),
    ).toBe("Loading card reader… 42%");
  });

  test("engine loading without total reports megabytes", () => {
    expect(
      announcementFor(
        withEngine({
          status: "loading",
          loaded: 5 * 1024 * 1024,
          total: null,
        }),
      ),
    ).toBe("Loading card reader… 5MB");
  });

  test("idle notice is announced", () => {
    const state: AppState = {
      engine: { status: "ready" },
      screen: { phase: "idle", notice: "Some cards are cut off." },
    };
    expect(announcementFor(state)).toBe("Some cards are cut off.");
  });

  test("ready idle is quiet", () => {
    const state: AppState = {
      engine: { status: "ready" },
      screen: { phase: "idle", notice: null },
    };
    expect(announcementFor(state)).toBe("");
  });

  test("engine failure announces the failure copy", () => {
    expect(
      announcementFor(withEngine({ status: "failed", message: "x" })),
    ).toMatch(/card reader/i);
  });
});
```

(The analyzing/results cases need a `Capture`/`FrameAnalysis` — add
two more tests mirroring `state.test.ts`'s helpers: analyzing →
`"Analyzing…"`; results with 1 triple and 12 cards →
`"1 set found. 12 cards read."`; results with 0 triples →
`"No set found among the 8 cards."`. Copy the `captureOf`/`analysisOf`
helpers from `src/app/state.test.ts`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/ui/readings.test.ts src/ui/announce.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the pure modules**

`src/ui/readings.ts`:

```ts
import type { DetectedCard } from "../model";

export function reading(card: DetectedCard): string {
  const { count, color, shape, fill } = card.card;
  const plural = count > 1 ? "s" : "";
  return `${count} ${fill} ${color} ${shape}${plural}`;
}
```

`src/ui/announce.ts`:

```ts
import type { AppState } from "../app/state";
import { edgeNotice } from "../app/guidance";

function engineText(engine: AppState["engine"]): string | null {
  if (engine.status === "loading") {
    const { loaded, total } = engine;
    const amount = total
      ? `${Math.round((loaded / total) * 100)}%`
      : `${Math.round(loaded / 1024 / 1024)}MB`;
    return `Loading card reader… ${amount}`;
  }
  if (engine.status === "failed") {
    return "The card reader stopped working. Use Retry to restart.";
  }
  return null;
}

// One string per app state for the persistent aria-live region.
// Pure so it is trivially testable; App mutates the region's text,
// never the region itself.
export function announcementFor(state: AppState): string {
  const engine = engineText(state.engine);
  if (engine) return engine;
  const { screen } = state;
  switch (screen.phase) {
    case "idle":
      return screen.notice ?? "";
    case "analyzing":
      return "Analyzing…";
    case "results": {
      const sets = screen.triples.length;
      const cards = screen.analysis.cards.length;
      const summary =
        cards === 0
          ? "No cards detected. Try filling the frame with the spread."
          : sets === 0
            ? `No set found among the ${cards} cards.`
            : `${sets} set${sets > 1 ? "s" : ""} found. ` +
              `${cards} cards read.`;
      const edge = edgeNotice(screen.analysis);
      return edge ? `${summary} ${edge}` : summary;
    }
  }
}
```

- [ ] **Step 4: Run pure tests to verify pass**

Run: `npx vitest run src/ui/readings.test.ts src/ui/announce.test.ts`
Expected: all pass.

- [ ] **Step 5: Components + shell**

`src/ui/SrResults.tsx`:

```tsx
import type { FrameAnalysis } from "../model";
import type { SetTriple } from "../set";
import { reading } from "./readings";

// The accessible results list. Visually hidden, semantically primary:
// the visual overlay is aria-hidden and never the sole representation
// (spec + Plan B final review invariant).
export function SrResults({
  analysis,
  triples,
  selected,
}: {
  analysis: FrameAnalysis;
  triples: SetTriple[];
  selected: number;
}) {
  return (
    <ol className="sr-only" aria-label="Detected cards">
      {analysis.cards.map((card) => (
        <li key={card.id}>
          {reading(card)}
          {selected >= 0 && triples[selected]?.includes(card.id)
            ? " — in the highlighted set"
            : ""}
        </li>
      ))}
    </ol>
  );
}
```

`src/ui/Hud.tsx`:

```tsx
import type { FrameAnalysis } from "../model";
import type { SetTriple } from "../set";

export function Hud({
  analysis,
  triples,
  selected,
  onSelect,
  onRetake,
  onReanalyze,
}: {
  analysis: FrameAnalysis;
  triples: SetTriple[];
  selected: number;
  onSelect(index: number): void;
  onRetake(): void;
  onReanalyze(): void;
}) {
  const cards = analysis.cards.length;
  const summary =
    cards === 0
      ? "No cards found"
      : triples.length === 0
        ? "No set here"
        : `${triples.length} set${triples.length > 1 ? "s" : ""} found`;
  return (
    <div className="hud">
      <p className="hud-summary">{summary}</p>
      {triples.length > 1 && (
        <div className="hud-chips" role="group" aria-label="Found sets">
          {triples.map((_, index) => (
            <button
              key={index}
              aria-pressed={index === selected}
              onClick={() => onSelect(index)}
            >
              {index + 1}
            </button>
          ))}
        </div>
      )}
      <div className="hud-actions">
        <button onClick={onRetake}>Retake</button>
        <button onClick={onReanalyze}>Re-analyze</button>
      </div>
    </div>
  );
}
```

`src/ui/App.tsx` — structural changes only (client/reducer wiring from
Plan B stays):

- Render shape becomes:

```tsx
  return (
    <main className="app">
      <div aria-live="polite" role="status" className="sr-only">
        {announcementFor(state)}
      </div>
      {/* stage: capture / analysis views, unchanged wiring */}
      {/* Hud + SrResults replace ResultsPanel in the results phase */}
    </main>
  );
```

- The results phase renders `<AnalysisView …/>` plus
  `<Hud analysis={screen.analysis} triples={screen.triples}
  selected={screen.selected} onSelect={…} onRetake={…}
  onReanalyze={…}/>` plus `<SrResults …/>`. Delete the
  `ResultsPanel` import and file.
- The visible engine-progress paragraph stays (it is the sighted
  user's progress bar) but loses `role="status"` (the persistent
  region now owns announcements — two live regions would
  double-speak).

`index.html`: viewport meta becomes

```html
    <meta name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

`src/ui/app.css` — full rewrite (fullscreen dark stage, floating HUD,
safe areas, sr-only):

```css
:root { color-scheme: dark; }
html, body, #root { height: 100%; margin: 0; }
body { background: #12233a; color: #f2f5f9;
  font: 16px/1.4 system-ui, sans-serif; }
.app { height: 100dvh; display: flex; flex-direction: column;
  overflow: hidden;
  padding: env(safe-area-inset-top) env(safe-area-inset-right)
    env(safe-area-inset-bottom) env(safe-area-inset-left); }
.sr-only { position: absolute; width: 1px; height: 1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.engine-progress { position: absolute; top: 0; left: 0; right: 0;
  text-align: center; padding: 0.5rem;
  background: rgba(0, 0, 0, 0.5); z-index: 3; margin: 0; }
.capture, .analysis-view { flex: 1; position: relative;
  overflow: hidden; background: #000; }
.capture video { width: 100%; height: 100%; object-fit: cover; }
.frame-space { position: absolute; top: 0; left: 0;
  transform-origin: 0 0; }
.frame-space > img { display: block; }
.overlay { position: absolute; inset: 0; }
.ghost { position: absolute; top: 0; left: 0; opacity: 0.9;
  transform-origin: 0 0; }
.outlines { position: absolute; top: 0; left: 0; }
.outline { fill: none; stroke-width: 6px; }
.outline.bystander { stroke: rgba(255, 255, 255, 0.6); }
.outline.member { stroke: #00e5ff; stroke-width: 10px; }
.outline.uncertain { stroke-dasharray: 18 12; }
.busy { position: absolute; inset: 0; display: grid;
  place-content: center; gap: 1rem;
  background: rgba(0, 0, 0, 0.45); z-index: 2; }
.primary { font-size: 1.25rem; padding: 0.9rem 1.6rem;
  border-radius: 999px; border: none;
  background: #00e5ff; color: #06121f; }
.shutter { position: absolute; bottom: 1.5rem; left: 50%;
  transform: translateX(-50%); z-index: 2; }
.capture-center { position: absolute; inset: 0; display: grid;
  place-content: center; gap: 1rem; text-align: center;
  padding: 1rem; z-index: 1; }
.picker { position: absolute; bottom: 1.5rem; right: 1rem;
  z-index: 2; font-size: 0.9rem; }
.picker input { display: none; }
.picker span { text-decoration: underline; cursor: pointer; }
.notice { background: rgba(255, 246, 214, 0.92); color: #33290a;
  padding: 0.5rem 0.75rem; border-radius: 8px; }
.hud { position: absolute; bottom: 0; left: 0; right: 0;
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.75rem calc(env(safe-area-inset-right) + 1rem)
    calc(env(safe-area-inset-bottom) + 0.75rem)
    calc(env(safe-area-inset-left) + 1rem);
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.75));
  z-index: 2; }
.hud-summary { flex: 1; margin: 0; font-weight: 600; }
.hud-chips { display: flex; gap: 0.4rem; }
.hud-chips button, .hud-actions button { border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  background: rgba(0, 0, 0, 0.4); color: #f2f5f9;
  padding: 0.45rem 0.9rem; }
.hud-chips button[aria-pressed="true"] { border-color: #00e5ff;
  color: #00e5ff; }
```

(CaptureView's markup gets the `capture-center` wrapper for the
priming CTA and `picker` styling — a `<span>` inside the label as the
visible affordance since the input is hidden. Keep its logic
untouched in this task; Task 4 rewires the stream.)

- [ ] **Step 6: Verify + commit**

`npx tsc -b` clean; `npx vitest run src/ui` green; `npm test` fully
green; `npm run build` green; prettier clean.

```bash
git add -A src/ui index.html
git commit -m "Rebuild UI as fullscreen stage with accessible HUD"
```

---

### Task 4: Persistent viewfinder across captures

**Files:**
- Create: `src/ui/camera-state.ts`, `src/ui/camera-state.test.ts`
- Modify: `src/ui/CaptureView.tsx`, `src/ui/App.tsx`

**Interfaces:**
- Produces:
  - Pure camera state machine (tested):
    `CameraState = "unprimed" | "starting" | "live" | "unavailable"`,
    `cameraReduce(state: CameraState, event: "enable" | "granted" |
    "denied" | "stopped"): CameraState` — enable only from
    unprimed/unavailable→starting; granted: starting→live; denied:
    any→unavailable; stopped: any→unprimed.
  - `CaptureView` keeps the `MediaStream` in a ref that survives
    phase changes: the `<video>` element is HIDDEN (CSS) during
    analyzing/results, never unmounted, so Retake returns to a LIVE
    viewfinder instantly with no re-permission and no restart.
- App structural change: `CaptureView` is mounted for ALL phases
  (idle/analyzing/results) as the stage's base layer; the
  photo/overlay views layer above it. `CaptureView` receives
  `active: boolean` (phase === "idle") controlling visibility of its
  controls, NOT its mount. Stream teardown happens only on App
  unmount.

- [ ] **Step 1: Write failing tests**

`src/ui/camera-state.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { cameraReduce } from "./camera-state";

describe("cameraReduce", () => {
  test("happy path: unprimed -> starting -> live", () => {
    expect(cameraReduce("unprimed", "enable")).toBe("starting");
    expect(cameraReduce("starting", "granted")).toBe("live");
  });
  test("denied lands unavailable; enable can retry from there", () => {
    expect(cameraReduce("starting", "denied")).toBe("unavailable");
    expect(cameraReduce("unavailable", "enable")).toBe("starting");
  });
  test("live ignores enable; stopped resets", () => {
    expect(cameraReduce("live", "enable")).toBe("live");
    expect(cameraReduce("live", "stopped")).toBe("unprimed");
  });
});
```

- [ ] **Step 2: Verify failure, implement**

Run: `npx vitest run src/ui/camera-state.test.ts` — FAIL.

`src/ui/camera-state.ts`:

```ts
export type CameraState = "unprimed" | "starting" | "live" | "unavailable";
export type CameraEvent = "enable" | "granted" | "denied" | "stopped";

export function cameraReduce(
  state: CameraState,
  event: CameraEvent,
): CameraState {
  switch (event) {
    case "enable":
      return state === "unprimed" || state === "unavailable"
        ? "starting"
        : state;
    case "granted":
      return state === "starting" ? "live" : state;
    case "denied":
      return "unavailable";
    case "stopped":
      return "unprimed";
  }
}
```

- [ ] **Step 3: Rewire CaptureView + App**

`CaptureView` changes (logic; keep capture handlers as-is):

- Props gain `active: boolean`.
- Replace the `useState<CameraState>` transitions with
  `cameraReduce` calls (single source of truth for transitions).
- The `<video>` element and stream ref persist for the component's
  life; controls (`primary`, `shutter`, `picker`, notices) render
  only when `active`.
- Root element: `<section className="capture" hidden={!active}>` is
  WRONG (hidden would pause some browsers' rendering but the stream
  stays alive; acceptable) — instead keep the section always visible
  as the base layer and let the photo view cover it (App renders
  AnalysisView after CaptureView in DOM order; both absolutely fill
  the stage).

`App` changes: render `<CaptureView active={screen.phase === "idle"}
… />` unconditionally inside the stage; analyzing/results views render
on top when applicable. Capture/retake flows otherwise unchanged.

- [ ] **Step 4: Verify + commit**

`npx tsc -b`; `npx vitest run src/ui` green; `npm test` green;
`npm run build` green; prettier clean. Manual dev check (best-effort
without hardware): load `npm run dev`, confirm no console errors and
the picker flow still reaches results.

```bash
git add -A src/ui
git commit -m "Keep the viewfinder alive across captures"
```

---

### Task 5: Hardening batch (final-review Importants + deferred guards)

**Files:**
- Modify: `src/ui/App.tsx`, `src/ui/homography.ts`
- Test: `src/ui/homography.test.ts` (add case), `src/app/state.test.ts`
  (unchanged — reducer untouched)

**Interfaces:** consumes error classes from `src/app/worker-client.ts`
(`DisposedError`, `EngineInitError`, `WorkerDiedError`,
`AnalyzeTimeoutError` — all now carry `.name`).

- [ ] **Step 1: DisposedError guard in analyzeCapture (final-review
  Important #2 — REQUIRED before Plan D's live loop)**

In `src/ui/App.tsx`, the `analyzeCapture` catch becomes:

```tsx
      .catch((error: Error) => {
        if (error instanceof DisposedError) return; // mount lifecycle
        dispatch(
          error instanceof AnalyzeError
            ? {
                type: "analysis-failed",
                stage: error.stage,
                message: error.message,
              }
            : { type: "engine-failed", message: error.message },
        );
      });
```

- [ ] **Step 2: Engine-failure surface with real retry + honest copy**

In `App.tsx`, replace the engine-failed early-return screen with a
stage-level panel that distinguishes failure modes and offers retry by
remounting the client-owning subtree (bump a `generation` state used
as `key` — a fresh mount creates a fresh client per the
client-per-mount contract). Because the client lives in App itself,
the cleanest cut: extract App's current body into `<Session
key={generation} onFatal={...}/>` — a child component owning
clientRef/reducer — and let the outer App render:

```tsx
export function App() {
  const [generation, setGeneration] = useState(0);
  return (
    <Session
      key={generation}
      onRetry={() => setGeneration((n) => n + 1)}
    />
  );
}
```

`Session` = the entire previous App body, plus: the engine-failed
panel renders copy by error class name carried in the failure message
— set `message` at dispatch time:
`EngineInitError` → "The card reader couldn't load. Check your
connection and retry."; `WorkerDiedError`/`AnalyzeTimeoutError` →
"The card reader stopped responding."; anything else → the raw
message. Panel shows a `Retry` `.primary` button calling `onRetry`.
(Reducer and state shapes unchanged; this is composition only.)

- [ ] **Step 3: Degenerate-quad guard (B8 deferral — NaN homography
  renders visible junk)**

`src/ui/homography.ts`, in `unitSquareToQuad`'s projective branch:

```ts
  const denominator = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denominator) < 1e-9) {
    // three collinear corners: no valid homography exists; fall back
    // to the affine mapping rather than emitting NaN into matrix3d
    return [
      p1.x - p0.x, p3.x - p0.x, p0.x,
      p1.y - p0.y, p3.y - p0.y, p0.y,
      0, 0, 1,
    ];
  }
```

Add to `src/ui/homography.test.ts`:

```ts
  test("degenerate quads yield finite (affine) homographies", () => {
    const collinear: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { x: 0, y: 100 },
    ];
    const h = rectToQuad(600, 384, collinear);
    for (const value of h) expect(Number.isFinite(value)).toBe(true);
  });
```

- [ ] **Step 4: Verify + commit**

TDD order for step 3 (test first, watch NaN fail, then guard).
`npx tsc -b`; `npx vitest run src/ui` green; `npm test` green;
`npm run build` green; prettier clean.

```bash
git add -A src/ui
git commit -m "Harden error surfaces, retry, and degenerate quads"
```

---

### Task 6: Install choreography

**Files:**
- Create: `src/app/install.ts`, `src/app/install.test.ts`
- Modify: `src/ui/App.tsx` (Session), `src/ui/app.css`

**Interfaces:**
- Produces (pure, tested):
  - `InstallDecision = "prompt" | "ios-hint" | "none"`
  - `installDecision(input: { hasDeferredPrompt: boolean;
    isIos: boolean; isStandalone: boolean; dismissed: boolean;
    successes: number }): InstallDecision` — `"none"` unless
    `successes >= 1` and not standalone and not dismissed;
    `"prompt"` when a deferred beforeinstallprompt event is held;
    `"ios-hint"` on iOS (no beforeinstallprompt there).
  - `isIosSafari(userAgent: string): boolean` (best-effort UA check,
    tested with a real iPhone UA string and a Chrome one)
- DOM wiring in `Session`: capture `beforeinstallprompt` in an effect
  (preventDefault + stash); count successful analyses in state
  (increment on `analysis-ok` reaching results with ≥1 card);
  `dismissed` persisted in `localStorage["vsetp-install-dismissed"]`.
  When `installDecision(...)` ≠ "none", the Hud area shows a small
  banner: prompt → "Install vsetp" button (calls the stashed event's
  `.prompt()`); ios-hint → "Add to Home Screen from the share menu to
  keep vsetp handy." Both with a dismiss ✕ that sets the localStorage
  flag. Spec: contextual AFTER first success — never an interrupting
  prompt on load.

- [ ] **Step 1: Failing tests**

`src/app/install.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { installDecision, isIosSafari } from "./install";

const base = {
  hasDeferredPrompt: false,
  isIos: false,
  isStandalone: false,
  dismissed: false,
  successes: 1,
};

describe("installDecision", () => {
  test("quiet before the first success", () => {
    expect(installDecision({ ...base, successes: 0 })).toBe("none");
  });
  test("prompt when the browser offered install", () => {
    expect(
      installDecision({ ...base, hasDeferredPrompt: true }),
    ).toBe("prompt");
  });
  test("ios hint on iOS", () => {
    expect(installDecision({ ...base, isIos: true })).toBe("ios-hint");
  });
  test("never when standalone or dismissed", () => {
    expect(
      installDecision({
        ...base,
        hasDeferredPrompt: true,
        isStandalone: true,
      }),
    ).toBe("none");
    expect(
      installDecision({
        ...base,
        hasDeferredPrompt: true,
        dismissed: true,
      }),
    ).toBe("none");
  });
});

describe("isIosSafari", () => {
  test("matches iPhone Safari, not desktop Chrome", () => {
    expect(
      isIosSafari(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
          "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 " +
          "Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
    expect(
      isIosSafari(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 " +
          "Safari/537.36",
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failure, implement**

`src/app/install.ts`:

```ts
export type InstallDecision = "prompt" | "ios-hint" | "none";

// Contextual install CTA policy (spec): only after a first successful
// analysis, never standalone, never after dismissal, never as an
// interrupting prompt on load.
export function installDecision(input: {
  hasDeferredPrompt: boolean;
  isIos: boolean;
  isStandalone: boolean;
  dismissed: boolean;
  successes: number;
}): InstallDecision {
  const { hasDeferredPrompt, isIos, isStandalone, dismissed, successes } =
    input;
  if (successes < 1 || isStandalone || dismissed) return "none";
  if (hasDeferredPrompt) return "prompt";
  if (isIos) return "ios-hint";
  return "none";
}

export function isIosSafari(userAgent: string): boolean {
  return /iPhone|iPad|iPod/.test(userAgent);
}
```

Wire in `Session` per the Interfaces block (effect for
beforeinstallprompt; success counter; localStorage; banner in the Hud
area with `.notice` styling + dismiss button).

- [ ] **Step 3: Verify + commit**

`npx vitest run src/app/install.test.ts` green; `npx tsc -b`;
`npm test`; `npm run build`; prettier — all green.

```bash
git add -A src/app src/ui
git commit -m "Add contextual install prompt after first success"
```

---

### Task 7: npm-OpenCV evaluation (decision record; implement only if green)

**Files:**
- Create: `docs/superpowers/decisions/2026-07-opencv-sourcing.md`
- Possibly modify (ONLY if the decision is GO): `package.json`,
  `bin/fetch-opencv.sh` (delete), build config for the copy step

**Interfaces:** none consumed by other tasks; the deliverable is a
decision record (and implementation only on GO).

- [ ] **Step 1: Evaluate against the recorded constraints**

Research (network access assumed; if unavailable, report BLOCKED):
candidate npm sources for OpenCV.js (e.g. `@techstark/opencv-js`,
official `opencv.js`-adjacent packages). The decision criteria — ALL
must hold for GO (from the progress ledger and spec):

1. Serves as a SOURCE ONLY: a build step copies one artifact into
   `public/vendor/<name>-<version>.js` so the runtime shape (separate,
   stably-named, precache-able, streamed-with-progress) is unchanged.
2. Provenance: the package is official or verifiably
   built-from-official-source (document the chain). A third-party
   rebuild without verifiable provenance is a FAIL on this criterion.
3. Single-threaded build available (GitHub Pages: no COOP/COEP).
4. Node-compatible for the ring-2 test loader (or the vendored copy
   remains what load-node consumes — which criterion 1 gives us).
5. **settleOpenCv caveat (B2 deferral):** if the npm artifact is a
   promise-returning factory, `settleOpenCv` must first grow a
   native-thenable-safe path (`delete` only strips own properties —
   a native Promise would NOT be neutered). Landing that change +
   tests is part of GO's cost.

- [ ] **Step 2: Write the decision record**

`docs/superpowers/decisions/2026-07-opencv-sourcing.md`: context (why
vendored today), candidates examined with versions, each criterion's
verdict with evidence, decision (GO/NO-GO), and — if NO-GO — the
trigger conditions that would reopen it. Honest NO-GO is a fully
successful outcome for this task.

- [ ] **Step 3: If GO (and only if GO)**

Implement: npm dep + a `prebuild`/`postinstall` copy script emitting
`public/vendor/`, delete `bin/fetch-opencv.sh`, keep the committed
artifact OR git-ignore it (decide in the record; committed keeps CI
hermetic), update `OPENCV_VENDOR_FILE` if the name changes, land the
`settleOpenCv` native-thenable path with unit tests FIRST. Full suite
+ build + deployed-site verification. Otherwise: decision record only.

- [ ] **Step 4: Commit**

```bash
git add -A docs/superpowers/decisions [plus impl files if GO]
git commit -m "Record OpenCV sourcing decision"
```

---

### Task 8: Deployed phone smoke (user-run)

**Files:** none (checklist + report).

This task is executed by the HUMAN on their phone against
`https://gnidan.github.io/vsetp/` with the coordinator collecting
results; an implementer subagent cannot perform it. The coordinator
presents this checklist to the user:

1. First load on cellular or Wi-Fi: determinate "Loading card
   reader…" progress; reaches ready.
2. Camera: "Enable camera" CTA → OS prompt only after tap → live
   viewfinder fullscreen; shutter → results with ghosts on a real
   spread (or any surface → honest "No cards found").
3. Retake returns to a LIVE viewfinder instantly (no re-permission).
4. Picker path with a gallery photo, including one taken in portrait
   (EXIF): overlay alignment correct.
5. Kill the network (airplane mode), reload: app loads from the
   service worker, camera + analysis work fully offline.
6. Install: after a successful analysis, the install banner appears
   (Android: native prompt; iOS: Add-to-Home-Screen hint); installed
   app launches standalone. KNOWN LIMITATION to confirm, not fail:
   camera does not work inside the installed app on iOS (WebKit bug)
   — picker path must still work there.
7. VoiceOver/TalkBack spot check: results are announced after
   analysis; the card list is readable.
8. Rotation: overlay stays aligned after rotating mid-results.

Outcomes recorded in `.superpowers/sdd/progress.md`; failures become
fix tasks before Plan C closes.

---

## Plan C completion criteria

- Deployed, installable, offline-capable app at
  `https://gnidan.github.io/vsetp/` — `dist/sw.js` precache verifiably
  includes the OpenCV artifact.
- Fullscreen camera-first UI with zero visible results chrome beyond
  the HUD; persistent live region + sr-only card list verified present
  in the DOM (a11y invariants).
- Final-review Importants closed: persistent live region (Task 3),
  DisposedError guard (Task 5); degenerate-quad guard landed (Task 5).
- Install choreography per spec (post-success, dismissible, iOS
  hint).
- OpenCV sourcing decision recorded (either way).
- Phone smoke checklist executed by the user with outcomes recorded;
  any failures fixed.
- All suites green throughout; whole-plan final review passed.

