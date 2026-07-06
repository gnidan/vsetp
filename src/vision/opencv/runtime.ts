import type { Cv } from "./cv";

// Settle an evaluated opencv.js export into an initialized cv object.
// CRITICAL: the Emscripten Module is a self-resolving thenable; if any
// code awaits it (including promise machinery adopting it), the
// microtask loop re-adopts forever and the consumer hangs at 100% CPU.
// We delete `then` up front — before any async gap — and wait on
// onRuntimeInitialized instead. This is the ONLY sanctioned settling
// path — see progress ledger. This delete is a no-op against a
// native-Promise-returning factory (e.g. Emscripten MODULARIZE
// builds) and will silently hang instead — see the npm-sourcing
// evaluation at docs/superpowers/decisions/2026-07-opencv-sourcing.md
// for an empirically confirmed case and the required fix shape.
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
