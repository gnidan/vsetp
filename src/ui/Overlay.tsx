import type { FrameAnalysis, Quad } from "../model";
import type { SetTriple } from "../set";
import { CARD_RASTER } from "../vision/adapter";
import { ghostFaceDataUrl } from "./card-face";
import { rectToQuad, toMatrix3d } from "./homography";
import { SetLines } from "./SetLines";

const UNCERTAIN_BELOW = 0.5;

function isUncertain(card: FrameAnalysis["cards"][number]): boolean {
  const c = card.confidence;
  return Math.min(c.count, c.color, c.shape, c.fill) < UNCERTAIN_BELOW;
}

function outlinePoints(quad: Quad): string {
  return quad.map((p) => `${p.x},${p.y}`).join(" ");
}

// Rendered inside a wrapper that establishes frame-pixel coordinates
// (AnalysisView scales it to the displayed image box). aria-hidden:
// the ResultsPanel carries the accessible representation.
// Spoiler parity: below the "sets" reveal mode, App passes triples=[]
// so no member emphasis or connection lines can render here.
export function Overlay({
  analysis,
  triples,
  selected,
}: {
  analysis: FrameAnalysis;
  triples: SetTriple[];
  selected: number;
}) {
  const members = new Set(selected >= 0 ? triples[selected] : []);
  const { width, height } = analysis.frameSize;
  return (
    <div className="overlay" aria-hidden="true">
      {analysis.cards.map((card) => (
        <img
          key={card.id}
          className="ghost"
          src={ghostFaceDataUrl(card.card)}
          alt=""
          width={CARD_RASTER.width}
          height={CARD_RASTER.height}
          style={{
            transform: toMatrix3d(
              rectToQuad(CARD_RASTER.width, CARD_RASTER.height, card.quad),
            ),
          }}
        />
      ))}
      <svg
        className="outlines"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
      >
        {analysis.cards.map((card) => (
          <polygon
            key={card.id}
            points={outlinePoints(card.quad)}
            className={[
              "outline",
              members.has(card.id) ? "member" : "bystander",
              isUncertain(card) ? "uncertain" : "",
            ].join(" ")}
          />
        ))}
      </svg>
      {triples.length > 0 && (
        <SetLines analysis={analysis} triples={triples} selected={selected} />
      )}
    </div>
  );
}
