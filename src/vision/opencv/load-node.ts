// Node-only module; the tsconfig "types" allowlist omits @types/node,
// so pull its declarations in here rather than project-wide.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cv } from "./cv";
import { OPENCV_VENDOR_FILE } from "./cv";
import { settleOpenCv } from "./runtime";

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
  return settleOpenCv(evaluateArtifact());
}

// Node-side loader for tests/tools. The browser/worker loader (streamed
// fetch with download progress) is Plan B; both consume the same
// vendored artifact.
export function loadOpenCv(): Promise<Cv> {
  cached ??= initialize();
  return cached;
}
