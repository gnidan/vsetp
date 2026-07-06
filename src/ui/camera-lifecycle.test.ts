import { describe, expect, test } from "vitest";
import { createCameraLifecycle } from "./camera-lifecycle";

describe("createCameraLifecycle", () => {
  test("a grant during a live mount is adopted", () => {
    const lifecycle = createCameraLifecycle();
    lifecycle.setup();
    const token = lifecycle.beginEnable();
    expect(lifecycle.isStale(token)).toBe(false);
  });

  test(
    "StrictMode replay (setup, teardown, setup) does not poison " +
      "the surviving instance",
    () => {
      const lifecycle = createCameraLifecycle();
      // dev double-mount: effect body, cleanup, effect body again —
      // all on the SAME component instance (refs persist)
      lifecycle.setup();
      lifecycle.teardown();
      lifecycle.setup();
      const token = lifecycle.beginEnable();
      expect(lifecycle.isStale(token)).toBe(false);
    },
  );

  test("a grant resolving after unmount is stale", () => {
    const lifecycle = createCameraLifecycle();
    lifecycle.setup();
    const token = lifecycle.beginEnable();
    lifecycle.teardown();
    expect(lifecycle.isStale(token)).toBe(true);
  });

  test("a newer enable supersedes a pending one", () => {
    const lifecycle = createCameraLifecycle();
    lifecycle.setup();
    const stale = lifecycle.beginEnable();
    const fresh = lifecycle.beginEnable();
    expect(lifecycle.isStale(stale)).toBe(true);
    expect(lifecycle.isStale(fresh)).toBe(false);
  });
});
