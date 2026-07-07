import type { Card, Track, TrackId } from "../model";
import { findSets, makeTableau } from "../set";
import type { SetIdentity } from "../set/identity";
import { disambiguateSetIdentities, setIdentityOf } from "../set/identity";

// A set found among live tracks: the triple of TrackIds plus the
// frame-independent identity of its member readings (spec: selection
// and styling key on identity, never array index).
export interface LiveSet {
  id: SetIdentity;
  trackIds: [TrackId, TrackId, TrackId];
}

// Pure derivation over LOCKED tracks only (spec): tentative and
// still-reading tracks never leak into set results. Output is
// sorted by identity so consecutive frames with the same locked
// readings produce identical lists; colliding identities get the
// same #n rule as findSetsInAnalysis.
export function liveSetsOf(tracks: Track[]): LiveSet[] {
  const entries = tracks.flatMap((track) =>
    track.state === "locked" && track.reading
      ? [{ id: track.trackId, card: track.reading }]
      : [],
  );
  const byId = new Map<TrackId, Card>(
    entries.map(({ id, card }) => [id, card]),
  );
  const cardOf = (id: TrackId): Card => {
    const found = byId.get(id);
    if (!found) throw new Error(`unknown TrackId ${id}`);
    return found;
  };
  const found = findSets(makeTableau<TrackId>(entries))
    .map((trackIds) => ({
      raw: setIdentityOf(trackIds.map(cardOf) as [Card, Card, Card]),
      trackIds,
    }))
    .sort(
      (a, b) =>
        (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0) ||
        a.trackIds[0] - b.trackIds[0] ||
        a.trackIds[1] - b.trackIds[1] ||
        a.trackIds[2] - b.trackIds[2],
    );
  const ids = disambiguateSetIdentities(found.map(({ raw }) => raw));
  return found.map(({ trackIds }, i) => ({ id: ids[i], trackIds }));
}
