import type { AnalyzedSet } from "../app/highlights";
import type { FrameAnalysis } from "../model";
import type { SetIdentity } from "../set/identity";
import { SET_LINE_CASING, setLineStyle, triangleFor } from "./set-lines";

// Connection triangles through each set's card centroids, in
// frame-pixel coordinates (same wrapper as the Overlay). aria-hidden:
// SrResults carries the accessible representation. Color/style stay
// assigned by array-order index (a static result never reshuffles);
// selection emphasis matches by identity.
export function SetLines({
  analysis,
  sets,
  selected,
}: {
  analysis: FrameAnalysis;
  sets: AnalyzedSet[];
  selected: SetIdentity | null;
}) {
  const { width, height } = analysis.frameSize;
  const quads = new Map(analysis.cards.map((card) => [card.id, card.quad]));
  return (
    <svg
      className="set-lines"
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
    >
      {sets.map((set, index) => {
        const members = set.triple.map((id) => quads.get(id));
        if (members.some((quad) => !quad)) return null;
        const points = triangleFor(members.map((quad) => quad!));
        const style = setLineStyle(index, set.id === selected);
        const dash = style.dash ?? undefined;
        return (
          <g key={set.id}>
            <polygon
              points={points}
              stroke={SET_LINE_CASING}
              strokeWidth={style.casingWidth}
              strokeDasharray={dash}
            />
            <polygon
              points={points}
              stroke={style.color}
              strokeWidth={style.coreWidth}
              strokeDasharray={dash}
            />
          </g>
        );
      })}
    </svg>
  );
}
