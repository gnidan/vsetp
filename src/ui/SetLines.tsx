import type { FrameAnalysis } from "../model";
import type { SetTriple } from "../set";
import { SET_LINE_CASING, setLineStyle, triangleFor } from "./set-lines";

// Connection triangles through each set's card centroids, in
// frame-pixel coordinates (same wrapper as the Overlay). aria-hidden:
// SrResults carries the accessible representation.
export function SetLines({
  analysis,
  triples,
  selected,
}: {
  analysis: FrameAnalysis;
  triples: SetTriple[];
  selected: number;
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
      {triples.map((triple, index) => {
        const members = triple.map((id) => quads.get(id));
        if (members.some((quad) => !quad)) return null;
        const points = triangleFor(members.map((quad) => quad!));
        const style = setLineStyle(index, index === selected);
        const dash = style.dash ?? undefined;
        return (
          <g key={index}>
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
