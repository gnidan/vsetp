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
    expect(installDecision({ ...base, hasDeferredPrompt: true })).toBe(
      "prompt",
    );
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
