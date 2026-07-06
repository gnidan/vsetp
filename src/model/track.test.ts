import { describe, expect, it } from "vitest";
import type { Track } from "./track";
import { trackId } from "./track";

describe("track model", () => {
  it("brands track ids", () => {
    const id = trackId(3);
    expect(id).toBe(3);
  });

  it("carries optional reading fields as plain data", () => {
    const track: Track = {
      trackId: trackId(1),
      quad: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 6 },
        { x: 0, y: 6 },
      ],
      state: "tentative",
    };
    expect(track.reading).toBeUndefined();
    expect(track.state).toBe("tentative");
  });
});
