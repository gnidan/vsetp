// Node-only module; the tsconfig "types" allowlist omits @types/node,
// so pull its declarations in here rather than project-wide.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cv } from "./cv";
import { OPENCV_VENDOR_FILE } from "./cv";

let cached: Promise<Cv> | undefined;

// The artifact is a sloppy-mode UMD/CommonJS file; this package is
// "type": "module", so require() would evaluate it as ESM (strict
// mode) and its trailing `Module = {}` global assignment throws
// "Module is not defined". Evaluate it as CommonJS by hand instead.
function evaluateArtifact(): Cv {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../../public/vendor", OPENCV_VENDOR_FILE);
  const source = readFileSync(file, "utf8");
  const module = { exports: {} as Cv };
  const evaluate = new Function(
    "module",
    "exports",
    "require",
    "__filename",
    "__dirname",
    source,
  );
  evaluate(module, module.exports, createRequire(file), file, dirname(file));
  return module.exports;
}

async function initialize(): Promise<Cv> {
  const cv = evaluateArtifact();
  // The module is an Emscripten thenable that resolves with itself;
  // promise adoption then re-chains it forever, starving the event
  // loop (vitest spins at 100% CPU). Remove `then` before this module
  // ever becomes a promise's resolution value, and wait for
  // onRuntimeInitialized instead — chaining the artifact's own handler
  // (it installs Mat.prototype.clone).
  if (cv.Mat) {
    delete cv.then;
    return cv; // already initialized
  }
  return new Promise<Cv>((res) => {
    const previous = cv.onRuntimeInitialized;
    cv.onRuntimeInitialized = () => {
      if (previous) previous();
      delete cv.then;
      res(cv);
    };
  });
}

// Node-side loader for tests/tools. The browser/worker loader (streamed
// fetch with download progress) is Plan B; both consume the same
// vendored artifact.
export function loadOpenCv(): Promise<Cv> {
  cached ??= initialize();
  return cached;
}
