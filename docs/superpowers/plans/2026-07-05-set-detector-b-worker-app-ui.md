# Set Detector Plan B: Worker + App + UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The working browser app: camera/picker capture, worker-hosted
analysis with download progress, and a results view with ghost-card
overlays and an accessible results panel — running locally via
`npm run dev`.

**Architecture:** The Plan A pipeline runs unchanged inside a module
web worker behind the spec's typed protocol map. The main thread owns
capture normalization (one canvas bakes EXIF + clamps resolution and
yields both the display image and a transferable RGBA `Frame`), a
promise-based `WorkerClient`, a reducer-driven three-state UI, and an
overlay that projects idealized card faces onto detected quads with CSS
`matrix3d` homographies.

**Tech Stack:** Existing scaffold (React 18 + Vite + TS strict +
vitest). No new runtime dependencies. PWA/manifest/deploy are Plan C.

**Spec:** `docs/superpowers/specs/2026-07-02-set-detector-design.md` —
this plan implements Worker protocol, Client façade, Capture
normalization, Highlight join, UI/app flow, Accessibility, and Error
handling. Consult `.superpowers/sdd/progress.md` for accumulated design
inputs.

## Global Constraints

- 80-character lines; double quotes; plain data + free functions (a
  factory returning a plain object is fine; no classes with
  getters/setters).
- Tests colocated with modules; `npm test` (which now includes the
  real-photo suites) and `npm run build` must be green at every commit;
  prettier-clean.
- **Never `await` the OpenCV module object** — it is a self-resolving
  thenable that hangs consumers. All settling goes through the shared
  runtime helper (Task 2).
- Everything crossing the worker boundary is structured-clone-safe;
  `Frame.pixels` is TRANSFERRED (zero-copy), never cloned.
- Every response correlates to a request; no unsolicited worker
  messages. `analyze` before `ready` is a protocol violation (error,
  not queue). Backpressure is newest-wins, depth 1.
- Worker death must never hang a promise: `onerror`/`onmessageerror`
  reject all in-flight; per-request watchdog `ANALYZE_TIMEOUT_MS =
  30_000`.
- Confidence contract (model/analysis.ts): ~P(correct), 0 = no signal.
  UI "uncertain" treatment threshold: `UNCERTAIN_BELOW = 0.5`, dashes
  the outline — line style, never hue, carries the signal (CVD
  constraint). Card readings render as words, never swatches alone.
- Overlay ghost content must remain 180°-rotationally symmetric (the
  pipeline's orientation is content-verified only up to 180°); no
  corner-anchored overlay content.
- Camera path: `getUserMedia` behind an explicit user-gesture CTA
  (never a cold prompt); `facingMode: "environment"`, ideal 1920×1080.
  Capability absence or denial collapses capture to the picker path
  with recovery guidance.
- Vendored artifact URL: `` `${import.meta.env.BASE_URL}vendor/${OPENCV_VENDOR_FILE}` ``
  (Vite serves `public/` at the base path; base is `/vsetp/`).
- "No cards detected" and "no set found" are OUTCOMES with distinct
  guidance, not errors.

---

### Task 1: Worker protocol map + boundary guards

**Files:**
- Create: `src/worker/protocol.ts`, `src/worker/protocol.test.ts`

**Interfaces:**
- Consumes: `Frame`, `FrameId`, `FrameAnalysis` from `src/model`;
  `DetectOptions` from `src/vision/adapter`.
- Produces (every worker/app task consumes these):
  - `WorkerProtocol` map; `RequestKind`, `RequestOf<K>`, `ResponseOf<K>`
  - `PipelineStage = "detect" | "rectify" | "segment" | "classify"`
  - `WorkerRequest`/`WorkerResponse` full unions
  - guards `isWorkerRequest(data: unknown): data is WorkerRequest`,
    `isWorkerResponse(data: unknown): data is WorkerResponse`
  - `INIT_KINDS`/`ANALYZE_KINDS` discriminant sets (guards use them)

- [ ] **Step 1: Write failing tests**

`src/worker/protocol.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { isWorkerRequest, isWorkerResponse } from "./protocol";

describe("boundary guards", () => {
  test("accepts every request kind", () => {
    expect(
      isWorkerRequest({ type: "init", wasmUrl: "/vendor/x.js" }),
    ).toBe(true);
    expect(
      isWorkerRequest({
        type: "analyze",
        frame: { id: 1, width: 2, height: 2, pixels: new ArrayBuffer(16) },
      }),
    ).toBe(true);
  });

  test("accepts every response kind", () => {
    for (const message of [
      { type: "init-progress", loaded: 10, total: null },
      { type: "ready" },
      { type: "init-error", message: "boom" },
      {
        type: "result",
        frameId: 1,
        analysis: {
          frameId: 1,
          frameSize: { width: 2, height: 2 },
          cards: [],
          timings: {},
        },
      },
      { type: "dropped", frameId: 1 },
      {
        type: "analyze-error",
        frameId: 1,
        stage: "detect",
        message: "boom",
      },
    ]) {
      expect(isWorkerResponse(message)).toBe(true);
    }
  });

  test("rejects junk", () => {
    expect(isWorkerRequest(null)).toBe(false);
    expect(isWorkerRequest({ type: "result" })).toBe(false);
    expect(isWorkerResponse({ type: "analyze" })).toBe(false);
    expect(isWorkerResponse("ready")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/worker` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/worker/protocol.ts`:

```ts
import type { Frame, FrameAnalysis, FrameId } from "../model";
import type { DetectOptions } from "../vision/adapter";

export type PipelineStage = "detect" | "rectify" | "segment" | "classify";

// THE protocol definition; everything else is derived from it.
// init-progress is a non-terminal response: it may arrive any number
// of times before ready/init-error settles the init request.
export interface WorkerProtocol {
  init: {
    request: { type: "init"; wasmUrl: string };
    response:
      | { type: "init-progress"; loaded: number; total: number | null }
      | { type: "ready" }
      | { type: "init-error"; message: string };
  };
  analyze: {
    request: { type: "analyze"; frame: Frame; options?: DetectOptions };
    response:
      | { type: "result"; frameId: FrameId; analysis: FrameAnalysis }
      | { type: "dropped"; frameId: FrameId }
      | {
          type: "analyze-error";
          frameId: FrameId;
          stage: PipelineStage;
          message: string;
        };
  };
}

export type RequestKind = keyof WorkerProtocol;
export type RequestOf<K extends RequestKind> =
  WorkerProtocol[K]["request"];
export type ResponseOf<K extends RequestKind> =
  WorkerProtocol[K]["response"];

export type WorkerRequest = RequestOf<RequestKind>;
export type WorkerResponse = ResponseOf<RequestKind>;

const REQUEST_TYPES = new Set(["init", "analyze"]);
const RESPONSE_TYPES = new Set([
  "init-progress",
  "ready",
  "init-error",
  "result",
  "dropped",
  "analyze-error",
]);

function discriminantOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const type = (data as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

// Thin discriminant guards: we control both ends and ship them in one
// build, so shape validation beyond the tag is dead weight (spec).
export function isWorkerRequest(data: unknown): data is WorkerRequest {
  const type = discriminantOf(data);
  return type !== null && REQUEST_TYPES.has(type);
}

export function isWorkerResponse(data: unknown): data is WorkerResponse {
  const type = discriminantOf(data);
  return type !== null && RESPONSE_TYPES.has(type);
}
```

- [ ] **Step 4: Run to verify pass; full suite; commit**

Run: `npx vitest run src/worker` — Expected: 3 passed. `npm test` green.

```bash
git add src/worker && git commit -m "Add typed worker protocol map with boundary guards"
```

---

### Task 2: Shared OpenCV runtime settling (extract from Node loader)

**Files:**
- Create: `src/vision/opencv/runtime.ts`,
  `src/vision/opencv/runtime.test.ts`
- Modify: `src/vision/opencv/load-node.ts` (delegate to the helper)

**Interfaces:**
- Produces: `settleOpenCv(loaded: unknown): Promise<Cv>` — the ONE
  place that knows how to turn whatever evaluating the artifact yields
  into an initialized `cv`, without ever `await`ing the thenable
  module. Both loaders (Node, Task 3 browser) use it.
- Consumes: `Cv` from `./cv`.

- [ ] **Step 1: Write failing tests (the thenable trap, unit-tested)**

`src/vision/opencv/runtime.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { settleOpenCv } from "./runtime";

describe("settleOpenCv", () => {
  test("returns an already-initialized module directly", async () => {
    const cv = { Mat: class {} };
    expect(await settleOpenCv(cv)).toBe(cv);
  });

  test("waits for onRuntimeInitialized", async () => {
    const cv: Record<string, unknown> = {};
    const settled = settleOpenCv(cv);
    expect(typeof cv.onRuntimeInitialized).toBe("function");
    (cv.onRuntimeInitialized as () => void)();
    expect(await settled).toBe(cv);
  });

  test("chains a pre-existing onRuntimeInitialized handler", async () => {
    let chained = false;
    const cv: Record<string, unknown> = {
      onRuntimeInitialized: () => {
        chained = true;
      },
    };
    const settled = settleOpenCv(cv);
    (cv.onRuntimeInitialized as () => void)();
    await settled;
    expect(chained).toBe(true);
  });

  test("neuters a self-resolving thenable without awaiting it", async () => {
    // the real artifact's Module is thenable and re-adopts itself
    // forever if awaited; settleOpenCv must delete `then` and settle
    // via onRuntimeInitialized instead
    let thenCalls = 0;
    const cv: Record<string, unknown> = {
      then: () => {
        thenCalls++;
      },
    };
    const settled = settleOpenCv(cv);
    expect("then" in cv).toBe(false); // neutered
    (cv.onRuntimeInitialized as () => void)();
    expect(await settled).toBe(cv);
    expect(thenCalls).toBe(0); // never awaited/adopted
  });

  test("calls a factory export and settles its product", async () => {
    const product: Record<string, unknown> = {};
    const factory = () => {
      queueMicrotask(() =>
        (product.onRuntimeInitialized as () => void)(),
      );
      return product;
    };
    expect(await settleOpenCv(factory)).toBe(product);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/vision/opencv/runtime.test.ts` — Expected:
FAIL.

- [ ] **Step 3: Implement, and delegate load-node to it**

`src/vision/opencv/runtime.ts`:

```ts
import type { Cv } from "./cv";

// Settle an evaluated opencv.js export into an initialized cv object.
// CRITICAL: the Emscripten Module is a self-resolving thenable; if any
// code awaits it (including promise machinery adopting it), the
// microtask loop re-adopts forever and the consumer hangs at 100% CPU.
// We delete `then` and wait on onRuntimeInitialized instead. This is
// the ONLY sanctioned settling path — see progress ledger.
export function settleOpenCv(loaded: unknown): Promise<Cv> {
  const candidate =
    typeof loaded === "function" ? (loaded as () => Cv)() : (loaded as Cv);
  if (candidate && typeof candidate.then === "function") {
    delete candidate.then;
  }
  if (candidate.Mat) return Promise.resolve(candidate);
  return new Promise<Cv>((resolve) => {
    const previous = candidate.onRuntimeInitialized;
    candidate.onRuntimeInitialized = () => {
      if (typeof previous === "function") previous();
      resolve(candidate);
    };
  });
}
```

In `src/vision/opencv/load-node.ts`, replace the settling logic inside
`initialize()` with a call to `settleOpenCv(loaded)` (keep the
`createRequire` evaluation exactly as is; delete the now-duplicated
thenable/onRuntimeInitialized handling; import `settleOpenCv` from
`./runtime`). The exported `loadOpenCv` signature and caching are
unchanged.

- [ ] **Step 4: Run to verify pass; full suite; commit**

Run: `npx vitest run src/vision/opencv` — Expected: runtime tests +
existing loader tests all pass. `npm test` green (real-photo suites
prove the Node loader still initializes the real artifact).

```bash
git add src/vision/opencv && git commit -m "Extract shared OpenCV runtime settling helper"
```

---

### Task 3: Browser/worker OpenCV loader with download progress

**Files:**
- Create: `src/vision/opencv/load-browser.ts`,
  `src/vision/opencv/load-browser.test.ts`

**Interfaces:**
- Consumes: `settleOpenCv` (Task 2), `Cv` from `./cv`.
- Produces: `loadOpenCvBrowser(url: string, onProgress?: (loaded:
  number, total: number | null) => void): Promise<Cv>` — streamed
  fetch (progress from Content-Length when present), CJS-style
  evaluation in the worker global, settled via `settleOpenCv`. Also
  exports `readWithProgress(response: Response, onProgress?):
  Promise<string>` for direct unit testing.

- [ ] **Step 1: Write failing tests (Node 22 has fetch/streams)**

`src/vision/opencv/load-browser.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { readWithProgress } from "./load-browser";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readWithProgress", () => {
  test("accumulates text and reports byte progress with total", async () => {
    const response = new Response(streamOf(["ab", "cde"]), {
      headers: { "Content-Length": "5" },
    });
    const events: [number, number | null][] = [];
    const text = await readWithProgress(response, (loaded, total) =>
      events.push([loaded, total]),
    );
    expect(text).toBe("abcde");
    expect(events).toEqual([
      [2, 5],
      [5, 5],
    ]);
  });

  test("reports null total without Content-Length", async () => {
    const response = new Response(streamOf(["xy"]));
    const events: [number, number | null][] = [];
    await readWithProgress(response, (loaded, total) =>
      events.push([loaded, total]),
    );
    expect(events).toEqual([[2, null]]);
  });

  test("throws on non-OK responses", async () => {
    const response = new Response("nope", { status: 404 });
    await expect(readWithProgress(response)).rejects.toThrow(/404/);
  });
});
```

NOTE: `new Response(stream)` may set no content-length; if the runtime
injects one in the first test, construct via a bare object with
`{ ok, status, headers, body }` shape instead — `readWithProgress`
must only depend on `ok`, `status`, `headers.get`, and `body`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/vision/opencv/load-browser.test.ts` —
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/vision/opencv/load-browser.ts`:

```ts
import type { Cv } from "./cv";
import { settleOpenCv } from "./runtime";

type Progress = (loaded: number, total: number | null) => void;

interface FetchedBody {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  text?: () => Promise<string>;
}

export async function readWithProgress(
  response: FetchedBody,
  onProgress?: Progress,
): Promise<string> {
  if (!response.ok) {
    throw new Error(`opencv fetch failed: HTTP ${response.status}`);
  }
  const header = response.headers.get("Content-Length");
  const total = header ? Number(header) : null;
  if (!response.body) {
    // environments without body streams: no incremental progress
    const text = await (response.text?.() ?? Promise.resolve(""));
    onProgress?.(text.length, total);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

// Evaluate the UMD artifact CJS-style in the worker global scope and
// settle it. Same technique as the Node loader; `new Function` keeps
// the sloppy-mode UMD out of our ESM module graph.
export async function loadOpenCvBrowser(
  url: string,
  onProgress?: Progress,
): Promise<Cv> {
  const source = await readWithProgress(await fetch(url), onProgress);
  const moduleShim = { exports: {} as unknown };
  const evaluate = new Function("module", "exports", source);
  evaluate(moduleShim, moduleShim.exports);
  return settleOpenCv(moduleShim.exports);
}
```

- [ ] **Step 4: Run to verify pass; full suite; commit**

Run: `npx vitest run src/vision/opencv` — Expected: all pass. `npm
test` green; `npm run build` green.

```bash
git add src/vision/opencv && git commit -m "Add streaming browser loader for the OpenCV artifact"
```

---

### Task 4: Newest-wins mailbox (pure)

**Files:**
- Create: `src/worker/mailbox.ts`, `src/worker/mailbox.test.ts`

**Interfaces:**
- Consumes: `Frame`, `FrameId` from `src/model`; `DetectOptions`.
- Produces (Task 5's worker entry consumes):
  - `Pending { frame: Frame; options?: DetectOptions }`
  - `Mailbox { waiting: Pending | null; pumping: boolean }`
  - `createMailbox(): Mailbox`
  - `accept(box: Mailbox, incoming: Pending): FrameId | null` — stores
    incoming as the sole waiting item; returns the frameId of a
    displaced waiting item (to answer `dropped`), else null
  - `next(box: Mailbox): Pending | null` — pops the waiting item
- Rationale note: the worker's `analyze` runs synchronously, so
  newest-wins depth-1 is realized by ACCEPTING messages as they arrive
  and PUMPING via a scheduled macrotask — message events queued during
  a sync analysis are all accepted (displacing each other) before the
  pump processes the survivor. The mailbox is the pure state; the pump
  loop lives in the worker entry.

- [ ] **Step 1: Write failing tests**

`src/worker/mailbox.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { frameId } from "../model";
import type { Frame } from "../model";
import { accept, createMailbox, next } from "./mailbox";

function frameOf(id: number): Frame {
  return { id: frameId(id), width: 1, height: 1, pixels: new ArrayBuffer(4) };
}

describe("mailbox", () => {
  test("accepts into the empty slot without dropping", () => {
    const box = createMailbox();
    expect(accept(box, { frame: frameOf(1) })).toBeNull();
    expect(next(box)?.frame.id).toBe(1);
    expect(next(box)).toBeNull();
  });

  test("newest wins: displacing a waiting frame reports the drop", () => {
    const box = createMailbox();
    accept(box, { frame: frameOf(1) });
    expect(accept(box, { frame: frameOf(2) })).toBe(1);
    expect(accept(box, { frame: frameOf(3) })).toBe(2);
    expect(next(box)?.frame.id).toBe(3);
    expect(next(box)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/worker/mailbox.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/worker/mailbox.ts`:

```ts
import type { Frame, FrameId } from "../model";
import type { DetectOptions } from "../vision/adapter";

export interface Pending {
  frame: Frame;
  options?: DetectOptions;
}

// Depth-1 newest-wins mailbox: at most one waiting frame; a newer
// arrival displaces it (the displaced frame is answered "dropped").
export interface Mailbox {
  waiting: Pending | null;
  pumping: boolean;
}

export function createMailbox(): Mailbox {
  return { waiting: null, pumping: false };
}

export function accept(box: Mailbox, incoming: Pending): FrameId | null {
  const dropped = box.waiting ? box.waiting.frame.id : null;
  box.waiting = incoming;
  return dropped;
}

export function next(box: Mailbox): Pending | null {
  const pending = box.waiting;
  box.waiting = null;
  return pending;
}
```

- [ ] **Step 4: Run to verify pass; commit**

Run: `npx vitest run src/worker/mailbox.test.ts` — Expected: 2 passed.

```bash
git add src/worker && git commit -m "Add newest-wins worker mailbox"
```

---

### Task 5: Worker entry (handler wiring + stage attribution)

**Files:**
- Create: `src/worker/stage-tracking.ts`,
  `src/worker/stage-tracking.test.ts`, `src/worker/vision.worker.ts`

**Interfaces:**
- Consumes: protocol (Task 1), mailbox (Task 4), `loadOpenCvBrowser`
  (Task 3), `createCardVision` (`src/vision/opencv`), `analyze`
  (`src/vision/pipeline/analyze`), `FrameAnalysis` from `src/model`.
- Produces:
  - `withStageTracking(vision: CardVision, stage: { current:
    PipelineStage }): CardVision` — wraps the adapter so a throw
    anywhere in `analyze()` can be attributed: each adapter method
    sets `stage.current` on entry; after `segmentSymbols` returns,
    stage becomes `"classify"` (the remaining work is pure
    classification).
  - `src/worker/vision.worker.ts` — the worker entry Plan B's client
    spawns. Not unit-tested (thin wiring over tested parts); exercised
    end-to-end in Task 12's browser smoke.

- [ ] **Step 1: Write failing tests for stage tracking**

`src/worker/stage-tracking.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { Quad } from "../model";
import type { CardVision } from "../vision/adapter";
import type { PipelineStage } from "./protocol";
import { withStageTracking } from "./stage-tracking";

const quad: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

function fakeVision(overrides: Partial<CardVision> = {}): CardVision {
  return {
    detectCards: () => [quad],
    rectifyCard: () => new ImageData(2, 2),
    segmentSymbols: () => [],
    ...overrides,
  };
}

describe("withStageTracking", () => {
  test("attributes each adapter stage on entry", () => {
    const stage = { current: "detect" as PipelineStage };
    const vision = withStageTracking(
      fakeVision({
        rectifyCard: () => {
          throw new Error("boom");
        },
      }),
      stage,
    );
    vision.detectCards(new ImageData(2, 2));
    expect(stage.current).toBe("detect");
    expect(() => vision.rectifyCard(new ImageData(2, 2), quad)).toThrow();
    expect(stage.current).toBe("rectify");
  });

  test("after segmentation returns, failures belong to classify", () => {
    const stage = { current: "detect" as PipelineStage };
    const vision = withStageTracking(fakeVision(), stage);
    vision.segmentSymbols(new ImageData(2, 2));
    expect(stage.current).toBe("classify");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/worker/stage-tracking.test.ts` — Expected:
FAIL.

- [ ] **Step 3: Implement stage tracking and the worker entry**

`src/worker/stage-tracking.ts`:

```ts
import type { CardVision } from "../vision/adapter";
import type { PipelineStage } from "./protocol";

// Wrap the adapter so analyze() failures can name their stage: each
// method claims the stage on entry; once segmentation has returned,
// any later throw is pure classification work.
export function withStageTracking(
  vision: CardVision,
  stage: { current: PipelineStage },
): CardVision {
  return {
    detectCards: (frame, options) => {
      stage.current = "detect";
      return vision.detectCards(frame, options);
    },
    rectifyCard: (frame, quad) => {
      stage.current = "rectify";
      return vision.rectifyCard(frame, quad);
    },
    segmentSymbols: (card) => {
      stage.current = "segment";
      const regions = vision.segmentSymbols(card);
      stage.current = "classify";
      return regions;
    },
  };
}
```

`src/worker/vision.worker.ts`:

```ts
/// <reference lib="webworker" />
import type { FrameAnalysis } from "../model";
import { createCardVision } from "../vision/opencv";
import { loadOpenCvBrowser } from "../vision/opencv/load-browser";
import type { CardVision } from "../vision/adapter";
import { analyze } from "../vision/pipeline/analyze";
import { accept, createMailbox, next } from "./mailbox";
import type { Pending } from "./mailbox";
import type { PipelineStage, WorkerResponse } from "./protocol";
import { isWorkerRequest } from "./protocol";
import { withStageTracking } from "./stage-tracking";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const mailbox = createMailbox();
const stage = { current: "detect" as PipelineStage };
let vision: CardVision | null = null;

function post(response: WorkerResponse): void {
  scope.postMessage(response);
}

function process(pending: Pending): void {
  const { frame, options } = pending;
  try {
    if (!vision) throw new Error("analyze before ready");
    stage.current = "detect";
    const image = new ImageData(
      new Uint8ClampedArray(frame.pixels),
      frame.width,
      frame.height,
    );
    const { cards, timings } = analyze(vision, image, options);
    const analysis: FrameAnalysis = {
      frameId: frame.id,
      frameSize: { width: frame.width, height: frame.height },
      cards,
      timings,
    };
    post({ type: "result", frameId: frame.id, analysis });
  } catch (error) {
    post({
      type: "analyze-error",
      frameId: frame.id,
      stage: stage.current,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function pump(): void {
  mailbox.pumping = false;
  const pending = next(mailbox);
  if (!pending) return;
  process(pending);
  schedulePump(); // drain anything accepted while processing
}

function schedulePump(): void {
  if (mailbox.pumping) return;
  mailbox.pumping = true;
  setTimeout(pump, 0); // macrotask: queued messages accept first
}

async function initialize(wasmUrl: string): Promise<void> {
  try {
    const cv = await loadOpenCvBrowser(wasmUrl, (loaded, total) =>
      post({ type: "init-progress", loaded, total }),
    );
    vision = withStageTracking(createCardVision(cv), stage);
    post({ type: "ready" });
  } catch (error) {
    post({
      type: "init-error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

scope.onmessage = (event: MessageEvent) => {
  const data: unknown = event.data;
  if (!isWorkerRequest(data)) return;
  if (data.type === "init") {
    void initialize(data.wasmUrl);
    return;
  }
  // analyze
  const dropped = accept(mailbox, {
    frame: data.frame,
    options: data.options,
  });
  if (dropped !== null) post({ type: "dropped", frameId: dropped });
  schedulePump();
};
```

- [ ] **Step 4: Verify; commit**

Run: `npx vitest run src/worker` — Expected: all pass. `npx tsc -b`
clean (the `WebWorker` lib is already in tsconfig). `npm test` green.

```bash
git add src/worker && git commit -m "Add vision worker entry with stage attribution"
```

---

### Task 6: WorkerClient façade

**Files:**
- Create: `src/app/worker-client.ts`, `src/app/worker-client.test.ts`

**Interfaces:**
- Consumes: protocol types + guards (Task 1); `OPENCV_VENDOR_FILE`
  (`src/vision/opencv/cv`); `Frame`, `FrameAnalysis` from `src/model`;
  `DetectOptions`.
- Produces (UI tasks consume):
  - `AnalyzeResult = { status: "ok"; analysis: FrameAnalysis } |
    { status: "superseded" }`
  - `InitProgress = (loaded: number, total: number | null) => void`
  - `WorkerClient { init(onProgress?: InitProgress): Promise<void>;
    analyze(frame: Frame, options?: DetectOptions):
    Promise<AnalyzeResult>; dispose(): void }`
  - `createWorkerClient(options?: { createWorker?: () => WorkerLike;
    wasmUrl?: string; timeoutMs?: number }): WorkerClient`
  - `WorkerLike { postMessage(message: unknown, transfer?:
    Transferable[]): void; terminate(): void; onmessage:
    ((event: MessageEvent) => void) | null; onerror: ((event:
    unknown) => void) | null; onmessageerror: ((event: unknown) =>
    void) | null }` — the seam the fake worker implements
  - Error classes: `WorkerDiedError`, `DisposedError`,
    `AnalyzeTimeoutError`, `EngineInitError`, `AnalyzeError` (carries
    `stage: PipelineStage`)
  - `ANALYZE_TIMEOUT_MS = 30_000`
- Behavior contract:
  - `init()` idempotent (cached promise); spawns the worker lazily;
    progress callbacks from ALL init calls are invoked
  - `analyze()` awaits init internally; posts with
    `transfer: [frame.pixels]`; resolves `ok`/`superseded`
    (`dropped`), rejects `AnalyzeError` on `analyze-error`
  - worker `onerror`/`onmessageerror`, watchdog timeout, and
    `dispose()` reject ALL in-flight promises (init included) with
    their respective error classes; after failure/disposal every call
    rejects

- [ ] **Step 1: Write failing tests**

`src/app/worker-client.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";
import { frameId } from "../model";
import type { Frame, FrameAnalysis } from "../model";
import type { WorkerRequest, WorkerResponse } from "../worker/protocol";
import {
  AnalyzeError,
  AnalyzeTimeoutError,
  DisposedError,
  WorkerDiedError,
  createWorkerClient,
} from "./worker-client";
import type { WorkerLike } from "./worker-client";

class FakeWorker implements WorkerLike {
  sent: { message: WorkerRequest; transfer?: Transferable[] }[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  terminated = false;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.sent.push({ message: message as WorkerRequest, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(response: WorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent);
  }
}

function frameOf(id: number): Frame {
  return {
    id: frameId(id),
    width: 2,
    height: 2,
    pixels: new ArrayBuffer(16),
  };
}

function analysisOf(id: number): FrameAnalysis {
  return {
    frameId: frameId(id),
    frameSize: { width: 2, height: 2 },
    cards: [],
    timings: {},
  };
}

let worker: FakeWorker;
const client = () =>
  createWorkerClient({
    createWorker: () => worker,
    wasmUrl: "/vendor/test.js",
    timeoutMs: 50,
  });

beforeEach(() => {
  worker = new FakeWorker();
});

describe("init", () => {
  test("posts init once, resolves on ready, reports progress", async () => {
    const c = client();
    const progress = vi.fn();
    const first = c.init(progress);
    const second = c.init(); // idempotent
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0].message).toEqual({
      type: "init",
      wasmUrl: "/vendor/test.js",
    });
    worker.emit({ type: "init-progress", loaded: 5, total: 10 });
    worker.emit({ type: "ready" });
    await Promise.all([first, second]);
    expect(progress).toHaveBeenCalledWith(5, 10);
  });

  test("rejects on init-error", async () => {
    const c = client();
    const initialized = c.init();
    worker.emit({ type: "init-error", message: "no wasm" });
    await expect(initialized).rejects.toThrow(/no wasm/);
  });
});

describe("analyze", () => {
  async function readyClient() {
    const c = client();
    const initialized = c.init();
    worker.emit({ type: "ready" });
    await initialized;
    return c;
  }

  test("transfers a copy of the pixels, preserving the source frame", async () => {
    const c = await readyClient();
    const frame = frameOf(7);
    const resulted = c.analyze(frame);
    const sent = worker.sent[1];
    expect(sent.message.type).toBe("analyze");
    if (sent.message.type !== "analyze") throw new Error("unreachable");
    // the posted frame carries its own buffer (transferred), so the
    // caller's frame stays usable for re-analyze
    expect(sent.transfer).toEqual([sent.message.frame.pixels]);
    expect(sent.message.frame.pixels).not.toBe(frame.pixels);
    expect(frame.pixels.byteLength).toBe(16); // not detached
    worker.emit({ type: "result", frameId: frameId(7), analysis: analysisOf(7) });
    await expect(resulted).resolves.toEqual({
      status: "ok",
      analysis: analysisOf(7),
    });
  });

  test("resolves superseded on dropped", async () => {
    const c = await readyClient();
    const resulted = c.analyze(frameOf(8));
    worker.emit({ type: "dropped", frameId: frameId(8) });
    await expect(resulted).resolves.toEqual({ status: "superseded" });
  });

  test("rejects AnalyzeError with stage on analyze-error", async () => {
    const c = await readyClient();
    const resulted = c.analyze(frameOf(9));
    worker.emit({
      type: "analyze-error",
      frameId: frameId(9),
      stage: "segment",
      message: "boom",
    });
    await expect(resulted).rejects.toBeInstanceOf(AnalyzeError);
    await expect(resulted).rejects.toMatchObject({ stage: "segment" });
  });

  test("worker death rejects all in-flight promises", async () => {
    const c = await readyClient();
    const resulted = c.analyze(frameOf(10));
    worker.onerror?.(new Event("error"));
    await expect(resulted).rejects.toBeInstanceOf(WorkerDiedError);
    await expect(c.analyze(frameOf(11))).rejects.toBeInstanceOf(
      WorkerDiedError,
    );
  });

  test("watchdog timeout rejects and fails the client", async () => {
    vi.useFakeTimers();
    try {
      const c = await readyClient();
      const resulted = c.analyze(frameOf(12));
      const expectation = expect(resulted).rejects.toBeInstanceOf(
        AnalyzeTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(51);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  test("dispose terminates and rejects in-flight with DisposedError", async () => {
    const c = await readyClient();
    const resulted = c.analyze(frameOf(13));
    c.dispose();
    expect(worker.terminated).toBe(true);
    await expect(resulted).rejects.toBeInstanceOf(DisposedError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/worker-client.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/app/worker-client.ts`:

```ts
import type { Frame, FrameAnalysis, FrameId } from "../model";
import type { DetectOptions } from "../vision/adapter";
import { OPENCV_VENDOR_FILE } from "../vision/opencv/cv";
import type { PipelineStage, RequestOf } from "../worker/protocol";
import { isWorkerResponse } from "../worker/protocol";

export const ANALYZE_TIMEOUT_MS = 30_000;

export type AnalyzeResult =
  | { status: "ok"; analysis: FrameAnalysis }
  | { status: "superseded" };

export type InitProgress = (loaded: number, total: number | null) => void;

export class EngineInitError extends Error {}
export class WorkerDiedError extends Error {}
export class DisposedError extends Error {}
export class AnalyzeTimeoutError extends Error {}
export class AnalyzeError extends Error {
  constructor(
    message: string,
    public readonly stage: PipelineStage,
  ) {
    super(message);
  }
}

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
}

export interface WorkerClient {
  init(onProgress?: InitProgress): Promise<void>;
  analyze(frame: Frame, options?: DetectOptions): Promise<AnalyzeResult>;
  dispose(): void;
}

interface PendingAnalyze {
  resolve(result: AnalyzeResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function defaultWasmUrl(): string {
  const base =
    (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return `${base}vendor/${OPENCV_VENDOR_FILE}`;
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL("../worker/vision.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

export function createWorkerClient(
  options: {
    createWorker?: () => WorkerLike;
    wasmUrl?: string;
    timeoutMs?: number;
  } = {},
): WorkerClient {
  const timeoutMs = options.timeoutMs ?? ANALYZE_TIMEOUT_MS;
  const wasmUrl = options.wasmUrl ?? defaultWasmUrl();
  const makeWorker = options.createWorker ?? defaultWorker;

  let worker: WorkerLike | null = null;
  let initPromise: Promise<void> | null = null;
  let initSettle: { resolve(): void; reject(error: Error): void } | null =
    null;
  const progressListeners: InitProgress[] = [];
  const pending = new Map<FrameId, PendingAnalyze>();
  let fatal: Error | null = null;

  function failAll(error: Error): void {
    fatal = error;
    initSettle?.reject(error);
    initSettle = null;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function handleResponse(data: unknown): void {
    if (!isWorkerResponse(data)) return;
    switch (data.type) {
      case "init-progress":
        for (const listen of progressListeners) {
          listen(data.loaded, data.total);
        }
        return;
      case "ready":
        initSettle?.resolve();
        initSettle = null;
        return;
      case "init-error":
        failAll(new EngineInitError(data.message));
        return;
      case "result":
      case "dropped":
      case "analyze-error": {
        const entry = pending.get(data.frameId);
        if (!entry) return; // late reply after timeout/failure
        pending.delete(data.frameId);
        clearTimeout(entry.timer);
        if (data.type === "result") {
          entry.resolve({ status: "ok", analysis: data.analysis });
        } else if (data.type === "dropped") {
          entry.resolve({ status: "superseded" });
        } else {
          entry.reject(new AnalyzeError(data.message, data.stage));
        }
        return;
      }
    }
  }

  function post<K extends "init" | "analyze">(
    request: RequestOf<K>,
    transfer?: Transferable[],
  ): void {
    worker?.postMessage(request, transfer);
  }

  function init(onProgress?: InitProgress): Promise<void> {
    if (onProgress) progressListeners.push(onProgress);
    if (fatal) return Promise.reject(fatal);
    if (initPromise) return initPromise;
    worker = makeWorker();
    worker.onmessage = (event) => handleResponse(event.data);
    worker.onerror = () => failAll(new WorkerDiedError("worker error"));
    worker.onmessageerror = () =>
      failAll(new WorkerDiedError("message deserialization failed"));
    initPromise = new Promise<void>((resolve, reject) => {
      initSettle = { resolve, reject };
    });
    post<"init">({ type: "init", wasmUrl });
    return initPromise;
  }

  async function analyze(
    frame: Frame,
    options?: DetectOptions,
  ): Promise<AnalyzeResult> {
    await init();
    if (fatal) throw fatal;
    return new Promise<AnalyzeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // a silent worker is a dead worker: fail everything
        failAll(new AnalyzeTimeoutError(`no reply in ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(frame.id, { resolve, reject, timer });
      // transfer a COPY: transferring frame.pixels itself would
      // detach the caller's buffer and break re-analyze. The slice
      // is transferred (zero-copy at the message boundary); the
      // source frame stays whole.
      const payload = { ...frame, pixels: frame.pixels.slice(0) };
      post<"analyze">(
        { type: "analyze", frame: payload, options },
        [payload.pixels],
      );
    });
  }

  function dispose(): void {
    failAll(new DisposedError("client disposed"));
    worker?.terminate();
    worker = null;
    initPromise = null;
  }

  return { init, analyze, dispose };
}
```

- [ ] **Step 4: Run to verify pass; full suite; commit**

Run: `npx vitest run src/app/worker-client.test.ts` — Expected: 8
passed. `npm test` + `npm run build` green.

```bash
git add src/app && git commit -m "Add promise-based worker client with failure containment"
```

---

### Task 7: Capture normalization

**Files:**
- Create: `src/app/capture.ts`, `src/app/capture.test.ts`

**Interfaces:**
- Consumes: `Frame`, `FrameId`, `frameId` from `src/model`;
  `NORMALIZED_MAX_DIMENSION` from `src/vision/adapter`.
- Produces (UI consumes):
  - `Capture { frame: Frame; displayUrl: string; width: number;
    height: number; revoke(): void }` — `width`/`height` are the
    normalized dimensions (== frame dims; the display image shares the
    coordinate space BY CONSTRUCTION)
  - `captureFromVideo(video: HTMLVideoElement): Promise<Capture>`
  - `captureFromFile(file: File): Promise<Capture>` — throws
    `CaptureDecodeError` on undecodable input
  - pure, unit-tested: `clampedSize(width: number, height: number,
    max?: number): { width: number; height: number }` and
    `mintFrameId(): FrameId` (module-level monotonic counter)
- DOM notes (untestable in Node; keep this glue thin): one
  normalization canvas bakes EXIF and the clamp; the SAME canvas
  yields both the display blob URL and the analysis pixels. EXIF: try
  `createImageBitmap(file, { imageOrientation: "from-image" })`, fall
  back to `<img>` decode (modern `drawImage` applies EXIF for both).

- [ ] **Step 1: Write failing tests (pure parts)**

`src/app/capture.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { clampedSize, mintFrameId } from "./capture";

describe("clampedSize", () => {
  test("passes small frames through untouched", () => {
    expect(clampedSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  test("clamps the long edge to NORMALIZED_MAX_DIMENSION", () => {
    expect(clampedSize(4000, 3000)).toEqual({ width: 3072, height: 2304 });
    expect(clampedSize(3000, 4000)).toEqual({ width: 2304, height: 3072 });
  });

  test("rounds to integers", () => {
    const { width, height } = clampedSize(4032, 3024);
    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
    expect(width).toBe(3072);
  });
});

describe("mintFrameId", () => {
  test("is monotonic", () => {
    const a = mintFrameId();
    const b = mintFrameId();
    expect(b).toBeGreaterThan(a);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/capture.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/app/capture.ts`:

```ts
import type { Frame, FrameId } from "../model";
import { frameId } from "../model";
import { NORMALIZED_MAX_DIMENSION } from "../vision/adapter";

export class CaptureDecodeError extends Error {}

export interface Capture {
  frame: Frame;
  displayUrl: string;
  width: number;
  height: number;
  revoke(): void;
}

export function clampedSize(
  width: number,
  height: number,
  max: number = NORMALIZED_MAX_DIMENSION,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

let counter = 0;
export function mintFrameId(): FrameId {
  return frameId(++counter);
}

type Drawable = HTMLVideoElement | HTMLImageElement | ImageBitmap;

// The single normalization point (spec: Capture normalization): one
// canvas bakes EXIF orientation and the resolution clamp, then yields
// BOTH artifacts — display URL and analysis pixels — so the analyzed
// frame and the displayed image share one coordinate space by
// construction.
async function normalize(
  source: Drawable,
  sourceWidth: number,
  sourceHeight: number,
): Promise<Capture> {
  const { width, height } = clampedSize(sourceWidth, sourceHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new CaptureDecodeError("canvas 2d unavailable");
  context.drawImage(source, 0, 0, width, height);

  const image = context.getImageData(0, 0, width, height);
  const frame: Frame = {
    id: mintFrameId(),
    width,
    height,
    pixels: image.data.buffer,
  };
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.9),
  );
  if (!blob) throw new CaptureDecodeError("could not encode display image");
  const displayUrl = URL.createObjectURL(blob);
  return {
    frame,
    displayUrl,
    width,
    height,
    revoke: () => URL.revokeObjectURL(displayUrl),
  };
}

export async function captureFromVideo(
  video: HTMLVideoElement,
): Promise<Capture> {
  return normalize(video, video.videoWidth, video.videoHeight);
}

async function decodeFile(file: File): Promise<Drawable> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
    } catch {
      // fall through to <img> decode
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } catch {
    throw new CaptureDecodeError(`could not decode ${file.name}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function captureFromFile(file: File): Promise<Capture> {
  const source = await decodeFile(file);
  const width =
    "videoWidth" in source ? source.videoWidth : source.width;
  const height =
    "videoHeight" in source ? source.videoHeight : source.height;
  try {
    return await normalize(source, width, height);
  } finally {
    if ("close" in source) source.close();
  }
}
```

- [ ] **Step 4: Run to verify pass; commit**

Run: `npx vitest run src/app/capture.test.ts` — Expected: 4 passed.
`npx tsc -b` clean.

```bash
git add src/app && git commit -m "Add capture normalization with shared coordinate space"
```

---

### Task 8: Homography + display transform (pure math)

**Files:**
- Create: `src/ui/homography.ts`, `src/ui/homography.test.ts`

**Interfaces:**
- Consumes: `Point`, `Quad` from `src/model`.
- Produces (Overlay consumes):
  - `Homography = [number, number, number, number, number, number,
    number, number, number]` (row-major 3×3)
  - `rectToQuad(width: number, height: number, quad: Quad):
    Homography` — maps the axis-aligned rect (0,0)-(w,h), corner order
    TL,TR,BR,BL, onto the quad (same corner order as the pipeline's
    content-verified quads)
  - `applyHomography(h: Homography, p: Point): Point`
  - `toMatrix3d(h: Homography): string` — CSS `matrix3d(...)` string
    (column-major 4×4 with z passthrough)
  - `displayTransform(frame: { width: number; height: number },
    container: { width: number; height: number }): { scale: number;
    offsetX: number; offsetY: number }` — object-fit: contain math
    (the spec's ViewportTransform)

- [ ] **Step 1: Write failing tests**

`src/ui/homography.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { Quad } from "../model";
import {
  applyHomography,
  displayTransform,
  rectToQuad,
  toMatrix3d,
} from "./homography";

function expectClose(a: { x: number; y: number }, b: { x: number; y: number }) {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
}

describe("rectToQuad", () => {
  test("identity when the quad is the rect itself", () => {
    const quad: Quad = [
      { x: 0, y: 0 },
      { x: 600, y: 0 },
      { x: 600, y: 384 },
      { x: 0, y: 384 },
    ];
    const h = rectToQuad(600, 384, quad);
    expectClose(applyHomography(h, { x: 300, y: 192 }), { x: 300, y: 192 });
  });

  test("maps all four rect corners onto the quad corners", () => {
    const quad: Quad = [
      { x: 120, y: 80 },
      { x: 520, y: 60 },
      { x: 560, y: 300 },
      { x: 100, y: 340 },
    ];
    const h = rectToQuad(600, 384, quad);
    expectClose(applyHomography(h, { x: 0, y: 0 }), quad[0]);
    expectClose(applyHomography(h, { x: 600, y: 0 }), quad[1]);
    expectClose(applyHomography(h, { x: 600, y: 384 }), quad[2]);
    expectClose(applyHomography(h, { x: 0, y: 384 }), quad[3]);
  });

  test("perspective (non-affine) quads work: midpoints do not map affinely", () => {
    // trapezoid: pure affine cannot map a rect onto it
    const quad: Quad = [
      { x: 200, y: 100 },
      { x: 400, y: 100 },
      { x: 500, y: 300 },
      { x: 100, y: 300 },
    ];
    const h = rectToQuad(600, 384, quad);
    const center = applyHomography(h, { x: 300, y: 192 });
    // the projective center is NOT the affine average (300, 200);
    // it is pulled toward the wider edge
    expect(center.y).toBeGreaterThan(200);
  });
});

describe("toMatrix3d", () => {
  test("identity homography yields the identity matrix3d", () => {
    expect(toMatrix3d([1, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(
      "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)",
    );
  });
});

describe("displayTransform", () => {
  test("contain-fits landscape into landscape container", () => {
    const t = displayTransform(
      { width: 3072, height: 2304 },
      { width: 768, height: 768 },
    );
    expect(t.scale).toBeCloseTo(0.25);
    expect(t.offsetX).toBe(0);
    expect(t.offsetY).toBeCloseTo((768 - 576) / 2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/ui/homography.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement (Heckbert unit-square method)**

`src/ui/homography.ts`:

```ts
import type { Point, Quad } from "../model";

// row-major 3x3
export type Homography = [
  number, number, number,
  number, number, number,
  number, number, number,
];

// unit square (0,0)-(1,1) onto quad, corners TL,TR,BR,BL —
// Heckbert's closed-form projective mapping
function unitSquareToQuad(quad: Quad): Homography {
  const [p0, p1, p2, p3] = quad;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    // affine
    return [
      p1.x - p0.x, p3.x - p0.x, p0.x,
      p1.y - p0.y, p3.y - p0.y, p0.y,
      0, 0, 1,
    ];
  }
  const dx1 = p1.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dx2 = p3.x - p2.x;
  const dy2 = p3.y - p2.y;
  const denominator = dx1 * dy2 - dy1 * dx2;
  const g = (sx * dy2 - sy * dx2) / denominator;
  const h = (dx1 * sy - dy1 * sx) / denominator;
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ];
}

export function rectToQuad(
  width: number,
  height: number,
  quad: Quad,
): Homography {
  const h = unitSquareToQuad(quad);
  // compose with scale(1/width, 1/height): divide the first two
  // columns
  return [
    h[0] / width, h[1] / height, h[2],
    h[3] / width, h[4] / height, h[5],
    h[6] / width, h[7] / height, h[8],
  ];
}

export function applyHomography(h: Homography, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

// CSS matrix3d is column-major 4x4; embed the 3x3 with z passthrough
export function toMatrix3d(h: Homography): string {
  const m = [
    h[0], h[3], 0, h[6],
    h[1], h[4], 0, h[7],
    0, 0, 1, 0,
    h[2], h[5], 0, h[8],
  ];
  return `matrix3d(${m.join(",")})`;
}

// object-fit: contain — the spec's ViewportTransform
export function displayTransform(
  frame: { width: number; height: number },
  container: { width: number; height: number },
): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.min(
    container.width / frame.width,
    container.height / frame.height,
  );
  return {
    scale,
    offsetX: (container.width - frame.width * scale) / 2,
    offsetY: (container.height - frame.height * scale) / 2,
  };
}
```

- [ ] **Step 4: Run to verify pass; commit**

Run: `npx vitest run src/ui/homography.test.ts` — Expected: 5 passed.

```bash
git add src/ui && git commit -m "Add homography math and display transform for overlays"
```

---

### Task 9: Card-face SVG module (move glyphs from test to src)

**Files:**
- Create: `src/ui/card-face.ts`, `src/ui/card-face.test.ts`
- Modify: `test/synthetic/render.ts` (import from the new module)

**Interfaces:**
- Produces:
  - `cardFaceSvg(card: Card, height: number): string` — the `<g>`
    fragment (EXACTLY the current behavior of the private
    `cardFaceSvg` in `test/synthetic/render.ts`)
  - `cardFaceDataUrl(card: Card): string` —
    `data:image/svg+xml,...` of a standalone CARD_RASTER-sized SVG
    document (the Overlay's ghost image source)
  - `SYMBOL`, `INK` re-exported for the renderer
- **This is a MOVE, not a rewrite.** The glyph paths (including the
  tilde squiggle's chirality), stripe pattern, ink palette, symbol
  proportions, and layout math in `test/synthetic/render.ts` are
  measurement-calibrated against real cards. Cut-paste the private
  helpers (`INK`, `SYMBOL`, `symbolShape`, `fillAttrs`,
  `stripePattern`, `cardFaceSvg`) into `src/ui/card-face.ts`
  verbatim, export them, and change `test/synthetic/render.ts` to
  import them. Every existing suite (synthetic + real-photo) is the
  regression guard that the move changed nothing.

- [ ] **Step 1: Write failing tests**

`src/ui/card-face.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { CARD_RASTER } from "../vision/adapter";
import { cardFaceDataUrl, cardFaceSvg } from "./card-face";

describe("cardFaceSvg", () => {
  test("renders count symbols with the card's ink", () => {
    const svg = cardFaceSvg(
      { count: 3, color: "purple", shape: "diamond", fill: "open" },
      CARD_RASTER.height,
    );
    expect(svg.match(/<path/g)).toHaveLength(3);
    expect(svg).toContain("#6a2c91");
  });
});

describe("cardFaceDataUrl", () => {
  test("is a decodable standalone SVG document at raster size", () => {
    const url = cardFaceDataUrl({
      count: 1,
      color: "red",
      shape: "squiggle",
      fill: "striped",
    });
    expect(url.startsWith("data:image/svg+xml,")).toBe(true);
    const svg = decodeURIComponent(url.slice("data:image/svg+xml,".length));
    expect(svg).toContain(`width="${CARD_RASTER.width}"`);
    expect(svg).toContain("</svg>");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/ui/card-face.test.ts` — Expected: FAIL.

- [ ] **Step 3: Move the helpers**

Create `src/ui/card-face.ts`: move `INK`, `SYMBOL`, `symbolShape`,
`fillAttrs`, `stripePattern`, and `cardFaceSvg` from
`test/synthetic/render.ts` VERBATIM (adjust only the import paths:
`Card`/`Color`/`Fill`/`Shape` from `../model`, `CARD_RASTER` from
`../vision/adapter`), exporting each. Append:

```ts
export function cardFaceDataUrl(card: Card): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${CARD_RASTER.width}" height="${CARD_RASTER.height}">` +
    cardFaceSvg(card, CARD_RASTER.height) +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
```

In `test/synthetic/render.ts`: delete the moved helpers and import
them from `../../src/ui/card-face`. No other changes.

- [ ] **Step 4: Run to verify pass — including the regression guard**

Run: `npx vitest run src/ui/card-face.test.ts` — Expected: 2 passed.
Run: `npm test` — Expected: ALL suites green (synthetic renderer and
real-photo fixtures byte-identical behavior). If anything synthetic
fails, the move was not verbatim — fix the move, never the tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui test/synthetic && git commit -m "Move card-face SVG helpers into src for UI reuse"
```

---

### Task 10: Highlight join

**Files:**
- Create: `src/app/highlights.ts`, `src/app/highlights.test.ts`

**Interfaces:**
- Consumes: `FrameAnalysis`, `Quad`, `CardId` from `src/model`;
  `SetTriple`, `findSets`, `makeTableau` from `src/set`.
- Produces: `findSetsInAnalysis(analysis: FrameAnalysis): {
  triples: SetTriple[]; quadsFor(triple: SetTriple): Quad[] }` — the
  spec's one-stop id-join between solver output and geometry.

- [ ] **Step 1: Write failing tests**

`src/app/highlights.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { Card, DetectedCard, FrameAnalysis } from "../model";
import { cardFromKey, cardId, frameId } from "../model";
import type { CardKey } from "../model";
import { findSetsInAnalysis } from "./highlights";

function detected(id: number, key: string): DetectedCard {
  const card: Card = cardFromKey(key as CardKey);
  const base = id * 10;
  return {
    id: cardId(id),
    quad: [
      { x: base, y: 0 },
      { x: base + 5, y: 0 },
      { x: base + 5, y: 8 },
      { x: base, y: 8 },
    ],
    card,
    confidence: { count: 1, color: 1, shape: 1, fill: 1 },
  };
}

function analysisOf(cards: DetectedCard[]): FrameAnalysis {
  return {
    frameId: frameId(1),
    frameSize: { width: 100, height: 100 },
    cards,
    timings: {},
  };
}

describe("findSetsInAnalysis", () => {
  test("finds triples and joins them back to quads", () => {
    const analysis = analysisOf([
      detected(0, "1-red-oval-solid"),
      detected(1, "2-red-oval-solid"),
      detected(2, "3-red-oval-solid"),
      detected(3, "1-green-diamond-open"),
    ]);
    const { triples, quadsFor } = findSetsInAnalysis(analysis);
    expect(triples).toEqual([[cardId(0), cardId(1), cardId(2)]]);
    const quads = quadsFor(triples[0]);
    expect(quads).toHaveLength(3);
    expect(quads[1][0].x).toBe(10); // id 1's quad, by identity
  });

  test("no sets yields empty triples", () => {
    const analysis = analysisOf([detected(0, "1-red-oval-solid")]);
    expect(findSetsInAnalysis(analysis).triples).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/highlights.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/app/highlights.ts`:

```ts
import type { CardId, DetectedCard, FrameAnalysis, Quad } from "../model";
import type { SetTriple } from "../set";
import { findSets, makeTableau } from "../set";

// The one construction site of the id-join invariant between solver
// output and detection geometry (spec: Highlight join).
export function findSetsInAnalysis(analysis: FrameAnalysis): {
  triples: SetTriple[];
  quadsFor(triple: SetTriple): Quad[];
} {
  const byId = new Map<CardId, DetectedCard>(
    analysis.cards.map((card) => [card.id, card]),
  );
  const triples = findSets(
    makeTableau(analysis.cards.map(({ id, card }) => ({ id, card }))),
  );
  return {
    triples,
    quadsFor: (triple) =>
      triple.map((id) => {
        const found = byId.get(id);
        if (!found) throw new Error(`unknown CardId ${id}`);
        return found.quad;
      }),
  };
}
```

- [ ] **Step 4: Run to verify pass; commit**

Run: `npx vitest run src/app/highlights.test.ts` — Expected: 2 passed.

```bash
git add src/app && git commit -m "Add id-join between set solver and detection geometry"
```

---

### Task 11: App state reducer + guidance

**Files:**
- Create: `src/app/state.ts`, `src/app/state.test.ts`,
  `src/app/guidance.ts`, `src/app/guidance.test.ts`

**Interfaces:**
- Consumes: `Capture` (Task 7), `FrameAnalysis`, `FrameId`;
  `SetTriple` from `src/set`; `findSetsInAnalysis` (Task 10);
  `PipelineStage` (Task 1).
- Produces (App component consumes):

```ts
type EngineState =
  | { status: "cold" }
  | { status: "loading"; loaded: number; total: number | null }
  | { status: "ready" }
  | { status: "failed"; message: string };

type Screen =
  | { phase: "idle"; notice: string | null }
  | { phase: "analyzing"; capture: Capture }
  | {
      phase: "results";
      capture: Capture;
      analysis: FrameAnalysis;
      triples: SetTriple[];
      selected: number; // index into triples; -1 when none
    };

type AppState = { engine: EngineState; screen: Screen };

type AppEvent =
  | { type: "engine-progress"; loaded: number; total: number | null }
  | { type: "engine-ready" }
  | { type: "engine-failed"; message: string }
  | { type: "captured"; capture: Capture }
  | { type: "analysis-ok"; analysis: FrameAnalysis }
  | { type: "analysis-superseded"; frameId: FrameId }
  | { type: "analysis-failed"; stage: PipelineStage; message: string }
  | { type: "capture-failed"; message: string }
  | { type: "cancel" }
  | { type: "retake" }
  | { type: "reanalyze" }
  | { type: "select-set"; index: number };

function initialState(): AppState;
function reduce(state: AppState, event: AppEvent): AppState;
// guidance.ts:
function guidanceFor(stage: PipelineStage): string;
function edgeNotice(analysis: FrameAnalysis): string | null;
```

- Behavioral requirements the tests must pin:
  - `analysis-ok` only applies while `analyzing` AND
    `analysis.frameId === capture.frame.id` (a late result after
    cancel/re-capture is ignored — the async race from the spec)
  - `analysis-ok` computes triples via `findSetsInAnalysis`;
    `selected` starts at 0 when sets exist, -1 otherwise
  - `analysis-failed` returns to `idle` with
    `notice: guidanceFor(stage)`; `analysis-superseded` leaves the
    screen unchanged (a newer frame's result is coming)
  - `cancel` (analyzing→idle), `retake` (results→idle),
    `reanalyze` (results→analyzing, SAME capture)
  - engine events only touch `engine`; screen events only touch
    `screen`
  - `guidanceFor`: `detect` → framing/cut-off/glare wording
    ("Couldn't find cards — make sure the whole spread is in frame
    and tilt the phone to avoid glare."); `rectify`/`segment`/
    `classify` → "Couldn't read the cards — move closer, hold steady,
    and avoid casting a shadow." (spec's tabletop-real hints; NEVER
    the useless "more light")
  - `edgeNotice`: any card quad corner within `EDGE_MARGIN = 12` px of
    the frame boundary → "Some cards are cut off at the edge." else
    null

- [ ] **Step 1: Write the failing tests**

`src/app/guidance.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { FrameAnalysis } from "../model";
import { cardId, frameId } from "../model";
import { edgeNotice, guidanceFor } from "./guidance";

describe("guidanceFor", () => {
  test("detect failures get framing guidance", () => {
    expect(guidanceFor("detect")).toMatch(/in frame|glare/i);
  });
  test("classify failures get closer/steadier guidance", () => {
    expect(guidanceFor("classify")).toMatch(/closer|steady/i);
  });
});

describe("edgeNotice", () => {
  const card = (x: number) => ({
    id: cardId(0),
    quad: [
      { x, y: 50 },
      { x: x + 40, y: 50 },
      { x: x + 40, y: 110 },
      { x, y: 110 },
    ] as FrameAnalysis["cards"][number]["quad"],
    card: {
      count: 1,
      color: "red",
      shape: "oval",
      fill: "open",
    } as const,
    confidence: { count: 1, color: 1, shape: 1, fill: 1 },
  });
  const analysisAt = (x: number): FrameAnalysis => ({
    frameId: frameId(1),
    frameSize: { width: 400, height: 300 },
    cards: [card(x)],
    timings: {},
  });

  test("flags a card touching the frame edge", () => {
    expect(edgeNotice(analysisAt(5))).toMatch(/cut off/i);
  });
  test("silent when all cards are interior", () => {
    expect(edgeNotice(analysisAt(100))).toBeNull();
  });
});
```

`src/app/state.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { Card, FrameAnalysis } from "../model";
import { cardFromKey, cardId, frameId } from "../model";
import type { CardKey } from "../model";
import type { Capture } from "./capture";
import { initialState, reduce } from "./state";

function captureOf(id: number): Capture {
  return {
    frame: { id: frameId(id), width: 4, height: 4, pixels: new ArrayBuffer(64) },
    displayUrl: `blob:${id}`,
    width: 4,
    height: 4,
    revoke: () => {},
  };
}

function analysisOf(id: number, keys: string[]): FrameAnalysis {
  return {
    frameId: frameId(id),
    frameSize: { width: 4, height: 4 },
    cards: keys.map((key, index) => ({
      id: cardId(index),
      quad: [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 2, y: 2 },
        { x: 1, y: 2 },
      ],
      card: cardFromKey(key as CardKey) as Card,
      confidence: { count: 1, color: 1, shape: 1, fill: 1 },
    })),
    timings: {},
  };
}

const SET_KEYS = ["1-red-oval-solid", "2-red-oval-solid", "3-red-oval-solid"];

describe("reduce", () => {
  test("captured moves idle to analyzing", () => {
    const state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(1),
    });
    expect(state.screen.phase).toBe("analyzing");
  });

  test("matching analysis-ok lands on results with sets selected", () => {
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(1),
    });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(1, SET_KEYS),
    });
    expect(state.screen.phase).toBe("results");
    if (state.screen.phase === "results") {
      expect(state.screen.triples).toHaveLength(1);
      expect(state.screen.selected).toBe(0);
    }
  });

  test("late analysis-ok for a stale frame is ignored", () => {
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(2),
    });
    state = reduce(state, { type: "cancel" });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(2, SET_KEYS),
    });
    expect(state.screen.phase).toBe("idle");
  });

  test("analysis-failed returns to idle with stage guidance", () => {
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(3),
    });
    state = reduce(state, {
      type: "analysis-failed",
      stage: "detect",
      message: "boom",
    });
    expect(state.screen.phase).toBe("idle");
    if (state.screen.phase === "idle") {
      expect(state.screen.notice).toMatch(/in frame|glare/i);
    }
  });

  test("reanalyze returns to analyzing with the same capture", () => {
    const capture = captureOf(4);
    let state = reduce(initialState(), { type: "captured", capture });
    state = reduce(state, {
      type: "analysis-ok",
      analysis: analysisOf(4, SET_KEYS),
    });
    state = reduce(state, { type: "reanalyze" });
    expect(state.screen.phase).toBe("analyzing");
    if (state.screen.phase === "analyzing") {
      expect(state.screen.capture).toBe(capture);
    }
  });

  test("engine events do not disturb the screen", () => {
    let state = reduce(initialState(), {
      type: "captured",
      capture: captureOf(5),
    });
    state = reduce(state, { type: "engine-ready" });
    expect(state.engine.status).toBe("ready");
    expect(state.screen.phase).toBe("analyzing");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/state.test.ts src/app/guidance.test.ts` —
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/app/guidance.ts`:

```ts
import type { FrameAnalysis } from "../model";
import type { PipelineStage } from "../worker/protocol";

const EDGE_MARGIN = 12;

// Tabletop-real guidance (spec: condition-based, never "more light")
export function guidanceFor(stage: PipelineStage): string {
  if (stage === "detect") {
    return (
      "Couldn't find cards — make sure the whole spread is in " +
      "frame and tilt the phone to avoid glare."
    );
  }
  return (
    "Couldn't read the cards — move closer, hold steady, and " +
    "avoid casting a shadow."
  );
}

export function edgeNotice(analysis: FrameAnalysis): string | null {
  const { width, height } = analysis.frameSize;
  const cutOff = analysis.cards.some((card) =>
    card.quad.some(
      (p) =>
        p.x < EDGE_MARGIN ||
        p.y < EDGE_MARGIN ||
        p.x > width - EDGE_MARGIN ||
        p.y > height - EDGE_MARGIN,
    ),
  );
  return cutOff ? "Some cards are cut off at the edge." : null;
}
```

`src/app/state.ts`:

```ts
import type { FrameAnalysis, FrameId } from "../model";
import type { SetTriple } from "../set";
import type { PipelineStage } from "../worker/protocol";
import type { Capture } from "./capture";
import { guidanceFor } from "./guidance";
import { findSetsInAnalysis } from "./highlights";

export type EngineState =
  | { status: "cold" }
  | { status: "loading"; loaded: number; total: number | null }
  | { status: "ready" }
  | { status: "failed"; message: string };

export type Screen =
  | { phase: "idle"; notice: string | null }
  | { phase: "analyzing"; capture: Capture }
  | {
      phase: "results";
      capture: Capture;
      analysis: FrameAnalysis;
      triples: SetTriple[];
      selected: number;
    };

export interface AppState {
  engine: EngineState;
  screen: Screen;
}

export type AppEvent =
  | { type: "engine-progress"; loaded: number; total: number | null }
  | { type: "engine-ready" }
  | { type: "engine-failed"; message: string }
  | { type: "captured"; capture: Capture }
  | { type: "analysis-ok"; analysis: FrameAnalysis }
  | { type: "analysis-superseded"; frameId: FrameId }
  | { type: "analysis-failed"; stage: PipelineStage; message: string }
  | { type: "capture-failed"; message: string }
  | { type: "cancel" }
  | { type: "retake" }
  | { type: "reanalyze" }
  | { type: "select-set"; index: number };

export function initialState(): AppState {
  return { engine: { status: "cold" }, screen: { phase: "idle", notice: null } };
}

function reduceScreen(screen: Screen, event: AppEvent): Screen {
  switch (event.type) {
    case "captured":
      return { phase: "analyzing", capture: event.capture };
    case "analysis-ok": {
      if (
        screen.phase !== "analyzing" ||
        screen.capture.frame.id !== event.analysis.frameId
      ) {
        return screen; // stale result: a cancel/re-capture won
      }
      const { triples } = findSetsInAnalysis(event.analysis);
      return {
        phase: "results",
        capture: screen.capture,
        analysis: event.analysis,
        triples,
        selected: triples.length > 0 ? 0 : -1,
      };
    }
    case "analysis-superseded":
      return screen; // a newer frame's result is coming
    case "analysis-failed":
      if (screen.phase !== "analyzing") return screen;
      return { phase: "idle", notice: guidanceFor(event.stage) };
    case "capture-failed":
      return { phase: "idle", notice: event.message };
    case "cancel":
      return screen.phase === "analyzing"
        ? { phase: "idle", notice: null }
        : screen;
    case "retake":
      return screen.phase === "results"
        ? { phase: "idle", notice: null }
        : screen;
    case "reanalyze":
      return screen.phase === "results"
        ? { phase: "analyzing", capture: screen.capture }
        : screen;
    case "select-set":
      return screen.phase === "results"
        ? { ...screen, selected: event.index }
        : screen;
    default:
      return screen;
  }
}

function reduceEngine(engine: EngineState, event: AppEvent): EngineState {
  switch (event.type) {
    case "engine-progress":
      return { status: "loading", loaded: event.loaded, total: event.total };
    case "engine-ready":
      return { status: "ready" };
    case "engine-failed":
      return { status: "failed", message: event.message };
    default:
      return engine;
  }
}

export function reduce(state: AppState, event: AppEvent): AppState {
  return {
    engine: reduceEngine(state.engine, event),
    screen: reduceScreen(state.screen, event),
  };
}
```

- [ ] **Step 4: Run to verify pass; full suite; commit**

Run: `npx vitest run src/app` — Expected: all app tests pass. `npm
test` green.

```bash
git add src/app && git commit -m "Add app state reducer and tabletop guidance"
```

---

### Task 12: UI components, wiring, and browser smoke

**Files:**
- Create: `src/ui/Overlay.tsx`, `src/ui/ResultsPanel.tsx`,
  `src/ui/CaptureView.tsx`, `src/ui/AnalysisView.tsx`,
  `src/ui/App.tsx`, `src/ui/app.css`
- Modify: `src/main.tsx`, `index.html` (viewport meta if missing)

**Interfaces:**
- Consumes: everything above. No unit tests for components (spec ring
  3: reducer/transform/client are the tested surface; components are
  thin and smoke-verified). `npx tsc -b` is the component gate plus
  the manual checklist below.
- A11y contract (spec): the DOM ResultsPanel is the PRIMARY reading
  surface (ARIA-live summary + card list with readings as words);
  the canvas-free Overlay is `aria-hidden`; uncertain = dashed
  outline (line style, not hue); highlight palette (cyan/white) is
  distinct from card inks.

- [ ] **Step 1: Implement the components**

`src/ui/Overlay.tsx`:

```tsx
import type { FrameAnalysis, Quad } from "../model";
import type { SetTriple } from "../set";
import { CARD_RASTER } from "../vision/adapter";
import { cardFaceDataUrl } from "./card-face";
import { rectToQuad, toMatrix3d } from "./homography";

const UNCERTAIN_BELOW = 0.5;

function isUncertain(card: FrameAnalysis["cards"][number]): boolean {
  const c = card.confidence;
  return Math.min(c.count, c.color, c.shape, c.fill) < UNCERTAIN_BELOW;
}

function outlinePoints(quad: Quad): string {
  return quad.map((p) => `${p.x},${p.y}`).join(" ");
}

// Rendered inside a wrapper that establishes frame-pixel coordinates
// (AnalysisView scales it to the displayed image box). aria-hidden:
// the ResultsPanel carries the accessible representation.
export function Overlay({
  analysis,
  triples,
  selected,
}: {
  analysis: FrameAnalysis;
  triples: SetTriple[];
  selected: number;
}) {
  const members = new Set(selected >= 0 ? triples[selected] : []);
  const { width, height } = analysis.frameSize;
  return (
    <div className="overlay" aria-hidden="true">
      {analysis.cards.map((card) => (
        <img
          key={card.id}
          className="ghost"
          src={cardFaceDataUrl(card.card)}
          alt=""
          width={CARD_RASTER.width}
          height={CARD_RASTER.height}
          style={{
            transform: toMatrix3d(
              rectToQuad(CARD_RASTER.width, CARD_RASTER.height, card.quad),
            ),
          }}
        />
      ))}
      <svg
        className="outlines"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
      >
        {analysis.cards.map((card) => (
          <polygon
            key={card.id}
            points={outlinePoints(card.quad)}
            className={[
              "outline",
              members.has(card.id) ? "member" : "bystander",
              isUncertain(card) ? "uncertain" : "",
            ].join(" ")}
          />
        ))}
      </svg>
    </div>
  );
}
```

`src/ui/ResultsPanel.tsx`:

```tsx
import type { FrameAnalysis } from "../model";
import { cardKey } from "../model";
import type { SetTriple } from "../set";
import { edgeNotice } from "../app/guidance";

function reading(card: FrameAnalysis["cards"][number]): string {
  const { count, color, shape, fill } = card.card;
  const plural = count > 1 ? "s" : "";
  return `${count} ${fill} ${color} ${shape}${plural}`;
}

export function ResultsPanel({
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
  const cards = analysis.cards;
  const summary =
    cards.length === 0
      ? "No cards detected. Try filling the frame with the spread."
      : triples.length === 0
        ? `No set among the ${cards.length} cards detected.`
        : `${triples.length} set${triples.length > 1 ? "s" : ""} found.`;
  const notice = edgeNotice(analysis);
  return (
    <section className="results-panel">
      <p aria-live="polite" className="summary">
        {summary}
      </p>
      {notice && <p className="notice">{notice}</p>}
      {triples.length > 1 && (
        <div className="set-chips" role="group" aria-label="Found sets">
          {triples.map((_, index) => (
            <button
              key={index}
              aria-pressed={index === selected}
              onClick={() => onSelect(index)}
            >
              Set {index + 1}
            </button>
          ))}
        </div>
      )}
      <ol className="card-list" aria-label="Detected cards">
        {cards.map((card) => (
          <li key={card.id}>
            {reading(card)}
            {selected >= 0 && triples[selected]?.includes(card.id)
              ? " — in the highlighted set"
              : ""}
          </li>
        ))}
      </ol>
      <div className="actions">
        <button onClick={onRetake}>Retake</button>
        <button onClick={onReanalyze}>Re-analyze</button>
      </div>
    </section>
  );
}
```

`src/ui/CaptureView.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import type { Capture } from "../app/capture";
import { captureFromFile, captureFromVideo } from "../app/capture";

type CameraState = "unprimed" | "starting" | "live" | "unavailable";

export function CaptureView({
  notice,
  onCapture,
  onCaptureError,
}: {
  notice: string | null;
  onCapture(capture: Capture): void;
  onCaptureError(message: string): void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camera, setCamera] = useState<CameraState>("unprimed");

  useEffect(
    () => () => streamRef.current?.getTracks().forEach((t) => t.stop()),
    [],
  );

  async function enableCamera() {
    setCamera("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCamera("live");
    } catch {
      setCamera("unavailable");
    }
  }

  async function shoot() {
    if (!videoRef.current) return;
    try {
      onCapture(await captureFromVideo(videoRef.current));
    } catch (error) {
      onCaptureError(
        error instanceof Error ? error.message : "capture failed",
      );
    }
  }

  async function pick(file: File | null) {
    if (!file) return;
    try {
      onCapture(await captureFromFile(file));
    } catch {
      onCaptureError(
        "Couldn't read that image — try a JPEG or PNG photo.",
      );
    }
  }

  return (
    <section className="capture">
      {notice && <p className="notice">{notice}</p>}
      {camera === "unprimed" && (
        <button className="primary" onClick={enableCamera}>
          Enable camera
        </button>
      )}
      {camera === "starting" && <p>Starting camera…</p>}
      <video
        ref={videoRef}
        playsInline
        muted
        hidden={camera !== "live"}
        aria-label="Camera viewfinder"
      />
      {camera === "live" && (
        <button className="primary shutter" onClick={shoot}>
          Analyze table
        </button>
      )}
      {camera === "unavailable" && (
        <p className="notice">
          Camera unavailable or blocked. You can still take photos with
          the button below — it uses your system camera. To re-enable
          the live viewfinder, allow camera access in your browser
          settings and reload.
        </p>
      )}
      <label className="picker">
        Choose or take a photo
        <input
          type="file"
          accept="image/*"
          onChange={(e) => void pick(e.target.files?.[0] ?? null)}
        />
      </label>
    </section>
  );
}
```

`src/ui/AnalysisView.tsx`:

```tsx
import { useLayoutEffect, useRef, useState } from "react";
import type { Capture } from "../app/capture";
import type { FrameAnalysis } from "../model";
import type { SetTriple } from "../set";
import { displayTransform } from "./homography";
import { Overlay } from "./Overlay";

export function AnalysisView({
  capture,
  analysis,
  triples,
  selected,
  busyLabel,
  onCancel,
}: {
  capture: Capture;
  analysis: FrameAnalysis | null; // null while analyzing
  triples: SetTriple[];
  selected: number;
  busyLabel: string | null;
  onCancel?: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) =>
      setContainer({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const t = displayTransform(capture, container);
  return (
    <div className="analysis-view" ref={boxRef}>
      <div
        className="frame-space"
        style={{
          width: capture.width,
          height: capture.height,
          transform:
            `translate(${t.offsetX}px, ${t.offsetY}px) ` +
            `scale(${t.scale})`,
        }}
      >
        <img
          src={capture.displayUrl}
          alt="Captured table"
          width={capture.width}
          height={capture.height}
        />
        {analysis && (
          <Overlay
            analysis={analysis}
            triples={triples}
            selected={selected}
          />
        )}
        {busyLabel && (
          <div className="busy" role="status">
            <p>{busyLabel}</p>
            {onCancel && <button onClick={onCancel}>Cancel</button>}
          </div>
        )}
      </div>
    </div>
  );
}
```

`src/ui/App.tsx`:

```tsx
import { useEffect, useMemo, useReducer, useRef } from "react";
import type { Capture } from "../app/capture";
import { initialState, reduce } from "../app/state";
import {
  AnalyzeError,
  createWorkerClient,
} from "../app/worker-client";
import { AnalysisView } from "./AnalysisView";
import { CaptureView } from "./CaptureView";
import { ResultsPanel } from "./ResultsPanel";

export function App() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const client = useMemo(() => createWorkerClient(), []);
  const lastCapture = useRef<Capture | null>(null);

  const startEngine = useMemo(
    () => () =>
      client
        .init((loaded, total) =>
          dispatch({ type: "engine-progress", loaded, total }),
        )
        .then(() => dispatch({ type: "engine-ready" }))
        .catch((error: Error) =>
          dispatch({ type: "engine-failed", message: error.message }),
        ),
    [client],
  );

  useEffect(() => {
    // spec: eager init overlaps the download with framing — EXCEPT on
    // a metered connection (saveData), where the ~10MB fetch waits
    // for capture intent (startEngine is idempotent; onCapture calls
    // it again).
    const connection = (
      navigator as { connection?: { saveData?: boolean } }
    ).connection;
    if (!connection?.saveData) void startEngine();
    return () => client.dispose();
  }, [client, startEngine]);

  // revoke the previous capture's display URL once replaced
  useEffect(() => {
    const current =
      state.screen.phase === "idle" ? null : state.screen.capture;
    if (lastCapture.current && lastCapture.current !== current) {
      lastCapture.current.revoke();
    }
    lastCapture.current = current;
  }, [state.screen]);

  function analyzeCapture(capture: Capture) {
    client
      .analyze(capture.frame)
      .then((result) =>
        dispatch(
          result.status === "ok"
            ? { type: "analysis-ok", analysis: result.analysis }
            : {
                type: "analysis-superseded",
                frameId: capture.frame.id,
              },
        ),
      )
      .catch((error: Error) =>
        dispatch(
          error instanceof AnalyzeError
            ? {
                type: "analysis-failed",
                stage: error.stage,
                message: error.message,
              }
            : { type: "engine-failed", message: error.message },
        ),
      );
  }

  function onCapture(capture: Capture) {
    dispatch({ type: "captured", capture });
    void startEngine(); // no-op unless init was saveData-deferred
    analyzeCapture(capture);
  }

  const { engine, screen } = state;

  if (engine.status === "failed") {
    return (
      <main className="app">
        <h1>vsetp</h1>
        <p className="notice">
          The card reader couldn't start: {engine.message}. Check your
          connection and reload to retry.
        </p>
      </main>
    );
  }

  return (
    <main className="app">
      <h1>vsetp</h1>
      {engine.status === "loading" && (
        <p role="status" className="engine-progress">
          Loading card reader…{" "}
          {engine.total
            ? `${Math.round((engine.loaded / engine.total) * 100)}%`
            : `${Math.round(engine.loaded / 1024 / 1024)}MB`}
        </p>
      )}
      {screen.phase === "idle" && (
        <CaptureView
          notice={screen.notice}
          onCapture={onCapture}
          onCaptureError={(message) =>
            dispatch({ type: "capture-failed", message })
          }
        />
      )}
      {screen.phase === "analyzing" && (
        <AnalysisView
          capture={screen.capture}
          analysis={null}
          triples={[]}
          selected={-1}
          busyLabel={
            engine.status === "ready" ? "Analyzing…" : "Warming up…"
          }
          onCancel={() => dispatch({ type: "cancel" })}
        />
      )}
      {screen.phase === "results" && (
        <>
          <AnalysisView
            capture={screen.capture}
            analysis={screen.analysis}
            triples={screen.triples}
            selected={screen.selected}
            busyLabel={null}
          />
          <ResultsPanel
            analysis={screen.analysis}
            triples={screen.triples}
            selected={screen.selected}
            onSelect={(index) => dispatch({ type: "select-set", index })}
            onRetake={() => dispatch({ type: "retake" })}
            onReanalyze={() => {
              const capture = screen.capture;
              dispatch({ type: "reanalyze" });
              analyzeCapture(capture);
            }}
          />
        </>
      )}
    </main>
  );
}
```

`src/ui/app.css`:

```css
.app { max-width: 64rem; margin: 0 auto; padding: 1rem; }
.notice { background: #fff6d6; padding: 0.5rem 0.75rem; }
.capture video { width: 100%; max-height: 60vh; background: #000; }
.primary { font-size: 1.25rem; padding: 0.75rem 1.5rem; }
.picker input { display: block; }
.analysis-view { position: relative; width: 100%; height: 70vh;
  overflow: hidden; background: #111; }
.frame-space { position: absolute; top: 0; left: 0;
  transform-origin: 0 0; }
.frame-space > img { display: block; }
.overlay { position: absolute; inset: 0; }
.ghost { position: absolute; top: 0; left: 0; opacity: 0.65;
  transform-origin: 0 0; }
.outlines { position: absolute; top: 0; left: 0; }
.outline { fill: none; stroke-width: 6px; }
.outline.bystander { stroke: rgba(255, 255, 255, 0.6); }
.outline.member { stroke: #00e5ff; stroke-width: 10px; }
.outline.uncertain { stroke-dasharray: 18 12; }
.busy { position: absolute; inset: 0; display: grid;
  place-content: center; background: rgba(0, 0, 0, 0.45);
  color: #fff; }
.set-chips button[aria-pressed="true"] { outline: 3px solid #00e5ff; }
.card-list li { padding: 0.15rem 0; }
```

`src/main.tsx` — replace the placeholder render:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./ui/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`index.html`: ensure
`<meta name="viewport" content="width=device-width, initial-scale=1" />`
is present in `<head>`.

- [ ] **Step 2: Typecheck + suites**

Run: `npx tsc -b` — Expected: clean. `npm test` green (nothing
component-level is unit-tested; everything the components consume is).
`npm run build` green.

- [ ] **Step 3: Browser smoke checklist (manual, `npm run dev`)**

Record each item's outcome in the task report:

1. Load http://localhost:5173/vsetp/ — engine progress indicator
   appears, reaches ready without console errors.
2. Picker path: choose `test/fixtures/tuning/pic2934145.webp` from
   disk — analyzing state with cancel, then results: ghosts land on
   cards, 12-card list in the panel, sets found with chips if >1,
   edge/uncertain treatments plausible.
3. Ghost check: ghost faces track card rotation/perspective (the
   matrix3d path) and readings match the ink.
4. Re-analyze: returns through analyzing back to identical results.
   Retake: returns to capture, display URL revoked (no console
   warnings).
5. Camera path (needs a webcam): "Enable camera" prompts only after
   the click; viewfinder runs; shutter produces results on a real
   spread if one is handy, or at least a "no cards" outcome state.
6. Deny camera permission (or run in a browser with none): capture
   collapses to the picker with recovery guidance; picker still
   works end to end.
7. Keyboard/screen-reader sanity: results summary is announced
   (aria-live), card list is readable, chips are buttons.
8. Kill the dev server mid-init (fresh reload, stop server):
   engine-failed screen with reload guidance, no hung spinner.

- [ ] **Step 4: Commit**

```bash
git add src/ui src/main.tsx index.html
git commit -m "Add browser app: capture, ghost overlay, results panel"
```

---

## Plan B completion criteria

- `npm test` green (all Plan A suites + new worker/app/ui suites);
  `npm run build` green; prettier clean.
- `npm run dev` serves a working app: photo in → ghost-overlaid,
  screen-reader-accessible results out; camera path works where
  hardware exists; every failure mode lands on guidance, never a hang.
- The smoke checklist from Task 12 recorded with outcomes.
- Plan C (PWA/manifest/service worker/deploy + the npm-OpenCV
  question) remains, tracked in the ledger.

