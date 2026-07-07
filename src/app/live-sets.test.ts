import { describe, expect, test } from "vitest";
import type { CardKey, Track, TrackState } from "../model";
import { cardFromKey, trackId } from "../model";
import { liveSetsOf } from "./live-sets";

function trackOf(
  id: number,
  key: string | null,
  state: TrackState = "locked",
): Track {
  const base = id * 10;
  return {
    trackId: trackId(id),
    quad: [
      { x: base, y: 0 },
      { x: base + 5, y: 0 },
      { x: base + 5, y: 8 },
      { x: base, y: 8 },
    ],
    state,
    ...(key === null ? {} : { reading: cardFromKey(key as CardKey) }),
  };
}

const SET_KEYS = ["1-red-oval-solid", "2-red-oval-solid", "3-red-oval-solid"];
const SET_ID = SET_KEYS.join("|");

describe("liveSetsOf", () => {
  test("finds a set among locked tracks with identity and ids", () => {
    const sets = liveSetsOf([
      trackOf(0, SET_KEYS[0]),
      trackOf(1, SET_KEYS[1]),
      trackOf(2, SET_KEYS[2]),
      trackOf(3, "1-green-diamond-open"),
    ]);
    expect(sets).toHaveLength(1);
    expect(sets[0].id).toBe(SET_ID);
    expect(sets[0].trackIds).toEqual([trackId(0), trackId(1), trackId(2)]);
  });

  test("only locked tracks participate", () => {
    const sets = liveSetsOf([
      trackOf(0, SET_KEYS[0]),
      trackOf(1, SET_KEYS[1]),
      trackOf(2, SET_KEYS[2], "uncertain-locked"),
      trackOf(3, "1-green-diamond-open", "reading"),
      trackOf(4, "2-green-diamond-open", "tentative"),
    ]);
    expect(sets).toEqual([]);
  });

  test("locked tracks without a reading are skipped", () => {
    const sets = liveSetsOf([
      trackOf(0, SET_KEYS[0]),
      trackOf(1, SET_KEYS[1]),
      trackOf(2, null),
    ]);
    expect(sets).toEqual([]);
  });

  test("output is sorted by identity regardless of track order", () => {
    const green = [
      "1-green-diamond-open",
      "2-green-diamond-open",
      "3-green-diamond-open",
    ];
    const tracks = [
      ...green.map((key, i) => trackOf(i, key)),
      ...SET_KEYS.map((key, i) => trackOf(i + 3, key)),
    ];
    const ids = liveSetsOf(tracks).map((set) => set.id);
    const reversedIds = liveSetsOf([...tracks].reverse()).map((set) => set.id);
    expect(ids).toEqual([green.join("|"), SET_ID]);
    expect(reversedIds).toEqual(ids);
  });

  test("colliding identities are disambiguated, not deduped", () => {
    // two tracks locked onto the same face key: two distinct
    // physical cards each complete a set with the same raw identity
    const sets = liveSetsOf([
      trackOf(0, SET_KEYS[0]),
      trackOf(1, SET_KEYS[0]),
      trackOf(2, SET_KEYS[1]),
      trackOf(3, SET_KEYS[2]),
    ]);
    expect(sets.map((set) => set.id)).toEqual([SET_ID, `${SET_ID}#2`]);
  });

  test("no tracks yields no sets", () => {
    expect(liveSetsOf([])).toEqual([]);
  });
});
