import type { Track } from "../model";
import { CARD_RASTER } from "../vision/adapter";
import { ghostFaceDataUrl } from "./card-face";
import { ghostTransform, quadPoints } from "./ghost-transform";
import { expandedHitBox } from "./stage-coords";

// Visual track states below "locked" render as cased outlines: the
// dark casing under the core stroke is the contrast floor (never a
// fainter line). Uncertainty is dashes, never hue (a11y invariant),
// so "reading" shimmers by opacity instead of any dash treatment.
function outlineClass(track: Track): string | null {
  switch (track.state) {
    case "tentative":
      return "tentative";
    case "reading":
      return "reading";
    case "uncertain-locked":
      return "uncertain";
    case "locked":
      return null;
  }
}

// One element per track, keyed by trackId so CSS transitions carry a
// track's ghost between updates instead of remounting it. aria-hidden
// (via LiveView's wrapper): SrLiveResults is the accessible channel.
//
// Every rendered element carries data-track-id, and an invisible
// per-track hit layer expands each quad's bounding box to the 44pt
// client floor (hitScale converts: client px = frame px × hitScale).
// LiveView's tap handler hit-tests all of these with
// document.elementsFromPoint — what you see is what you tap.
export function TrackGhosts({
  tracks,
  frameSize,
  hitScale,
}: {
  tracks: Track[];
  frameSize: { width: number; height: number };
  hitScale: number;
}) {
  const { width, height } = frameSize;
  const ghosts = tracks.filter(
    (track) =>
      (track.state === "locked" || track.state === "uncertain-locked") &&
      track.reading,
  );
  const outlined = tracks.filter((track) => outlineClass(track) !== null);
  return (
    <div className="track-ghosts">
      {ghosts.map((track) => (
        <img
          key={track.trackId}
          className={`ghost track-ghost${
            track.state === "uncertain-locked" ? " uncertain" : ""
          }`}
          data-track-id={track.trackId}
          src={ghostFaceDataUrl(track.reading!)}
          alt=""
          width={CARD_RASTER.width}
          height={CARD_RASTER.height}
          style={{ transform: ghostTransform(track.quad) }}
        />
      ))}
      <svg
        className="track-outlines"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
      >
        {outlined.map((track) => (
          <g
            key={track.trackId}
            className={`track-outline ${outlineClass(track)}`}
            data-track-id={track.trackId}
          >
            <polygon className="casing" points={quadPoints(track.quad)} />
            <polygon className="core" points={quadPoints(track.quad)} />
          </g>
        ))}
      </svg>
      {tracks.map((track) => {
        const box = expandedHitBox(track.quad, hitScale);
        return (
          <div
            key={track.trackId}
            className="track-hit"
            data-track-id={track.trackId}
            style={{
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
            }}
          />
        );
      })}
    </div>
  );
}
