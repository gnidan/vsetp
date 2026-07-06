import type { Cv } from "./cv";

// Settle an evaluated opencv.js export into an initialized cv object.
// CRITICAL: the Emscripten Module is a self-resolving thenable; if any
// code awaits it (including promise machinery adopting it), the
// microtask loop re-adopts forever and the consumer hangs at 100% CPU.
// We delete `then` up front — before any async gap — and wait on
// onRuntimeInitialized instead. This is the ONLY sanctioned settling
// path — see progress ledger.
export function settleOpenCv(loaded: unknown): Promise<Cv> {
  const candidate: Cv =
    typeof loaded === "function" ? (loaded as () => Cv)() : loaded;
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
