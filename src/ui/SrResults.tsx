import type { AnalyzedSet } from "../app/highlights";
import type { LiveSet } from "../app/live-sets";
import type { FrameAnalysis, Track } from "../model";
import type { SetIdentity } from "../set/identity";
import { reading } from "./readings";

// The accessible results list. Visually hidden, semantically primary:
// the visual overlay is aria-hidden and never the sole representation
// (spec + Plan B final review invariant). Spoiler parity: membership
// annotations appear only when the reveal mode discloses sets.
export function SrResults({
  analysis,
  sets,
  selected,
  revealSets,
}: {
  analysis: FrameAnalysis;
  sets: AnalyzedSet[];
  selected: SetIdentity | null;
  revealSets: boolean;
}) {
  const selectedSet = sets.find((set) => set.id === selected);
  return (
    <ol className="sr-only" aria-label="Detected cards">
      {analysis.cards.map((card) => (
        <li key={card.id}>
          {reading(card.card)}
          {revealSets && selectedSet?.triple.includes(card.id)
            ? " — in the highlighted set"
            : ""}
        </li>
      ))}
    </ol>
  );
}

// Live counterpart: LOCKED tracks' readings only (matching what the
// set derivation sees — tentative/reading/uncertain tracks never
// leak in). Spoiler parity is the caller's: below the "sets" reveal,
// App passes liveSets=[]/selected=null, so the membership suffix
// cannot appear.
export function SrLiveResults({
  tracks,
  liveSets,
  selected,
}: {
  tracks: Track[];
  liveSets: LiveSet[];
  selected: SetIdentity | null;
}) {
  const selectedSet = liveSets.find((set) => set.id === selected);
  const locked = tracks.filter(
    (track) => track.state === "locked" && track.reading,
  );
  return (
    <ol className="sr-only" aria-label="Cards in view">
      {locked.map((track) => (
        <li key={track.trackId}>
          {reading(track.reading!)}
          {selectedSet?.trackIds.includes(track.trackId)
            ? " — in the highlighted set"
            : ""}
        </li>
      ))}
    </ol>
  );
}
