import type { LiveSet } from "../app/live-sets";
import type { Track } from "../model";
import type { SetIdentity } from "../set/identity";
import {
  SET_LINE_CASING,
  SET_LINE_DASH,
  setLineWeights,
  triangleFor,
} from "./set-lines";

// Connection triangles through member track centroids, in live-frame
// coordinates. Unlike the still SetLines (index-colored: a static
// result never reshuffles), live colors come from the session color
// map so an identity keeps its color across churning updates.
// Selection emphasizes by weight, never hue.
export function LiveSetLines({
  tracks,
  sets,
  selected,
  colorFor,
  frameSize,
}: {
  tracks: Track[];
  sets: LiveSet[];
  selected: SetIdentity | null;
  colorFor(id: SetIdentity): { color: string; dash: boolean };
  frameSize: { width: number; height: number };
}) {
  const { width, height } = frameSize;
  const quads = new Map(tracks.map((track) => [track.trackId, track.quad]));
  return (
    <svg
      className="set-lines"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
    >
      {sets.map((set) => {
        const members = set.trackIds.map((id) => quads.get(id));
        if (members.some((quad) => !quad)) return null;
        const points = triangleFor(members.map((quad) => quad!));
        const { color, dash } = colorFor(set.id);
        const weights = setLineWeights(set.id === selected);
        const dashArray = dash ? SET_LINE_DASH : undefined;
        return (
          <g key={set.id}>
            <polygon
              points={points}
              stroke={SET_LINE_CASING}
              strokeWidth={weights.casingWidth}
              strokeDasharray={dashArray}
            />
            <polygon
              points={points}
              stroke={color}
              strokeWidth={weights.coreWidth}
              strokeDasharray={dashArray}
            />
          </g>
        );
      })}
    </svg>
  );
}
