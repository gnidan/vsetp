import type { AttributeConfidence } from "./analysis";
import type { Card, CardKey } from "./card";
import type { Point, Quad } from "./geometry";

export type TrackId = number & { readonly __brand: "TrackId" };

export function trackId(n: number): TrackId {
  return n as TrackId;
}

export type TrackState =
  "tentative" | "reading" | "locked" | "uncertain-locked";

// One tracked card as reported to the main thread: plain data, no
// pixels. trackId is stable for the track's lifetime (spec).
export interface Track {
  trackId: TrackId;
  quad: Quad;
  state: TrackState;
  reading?: Card;
  confidence?: AttributeConfidence;
  provenance?: "roi-assist";
}

export type MarkId = number & { readonly __brand: "MarkId" };

export function markId(n: number): MarkId {
  return n as MarkId;
}

// User feedback marks. Face marks key to CardKey (unique per deck);
// positional marks key to live-frame coordinates (spec).
export type Mark =
  | { type: "correct"; key: CardKey }
  | { type: "wrong"; key: CardKey }
  | { type: "not-a-card"; at: Point }
  | { type: "missed-card"; at: Point };
