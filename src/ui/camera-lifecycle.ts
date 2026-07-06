// Staleness guard for async camera grants. getUserMedia can resolve
// after the component unmounted, or after a newer enableCamera call
// superseded the pending one — in either case the grant must be
// released, not adopted.
//
// StrictMode contract: in dev, React replays the mount effect
// (setup, teardown, setup) on the SAME component instance, so
// mounted-ness MUST be re-established in setup(). Tracking it only
// in teardown() would permanently poison the surviving instance —
// the same failure family as the worker-client's dispose() bug
// (fixed by the client-per-mount pattern in d0ba838).
export interface CameraLifecycle {
  setup(): void;
  teardown(): void;
  beginEnable(): number;
  isStale(token: number): boolean;
}

export function createCameraLifecycle(): CameraLifecycle {
  let mounted = true;
  let generation = 0;
  return {
    setup() {
      mounted = true;
    },
    teardown() {
      mounted = false;
    },
    beginEnable() {
      return ++generation;
    },
    isStale(token) {
      return !mounted || token !== generation;
    },
  };
}
