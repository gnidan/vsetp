import type { MouseEvent as ReactMouseEvent } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { LIVE_FRAME_MAX_DIMENSION } from "../app/live-capture";
import { clampedSize } from "../app/capture";
import type { LiveSet } from "../app/live-sets";
import type { Point, Track, TrackId } from "../model";
import { trackId } from "../model";
import type { SetIdentity } from "../set/identity";
import { useCamera } from "./CameraProvider";
import { coverTransform } from "./homography";
import { LiveSetLines } from "./LiveSetLines";
import { MIN_HIT_CLIENT_PX, domToFrame, inNoFireZone } from "./stage-coords";
import { TrackGhosts } from "./TrackGhosts";

// What a tap on the live stage resolved to, in live-frame coords.
// "tracks": at least one rendered track element under the tap;
// "empty": open table (outside the edge no-fire zone);
// "marker": an unresolved missed-card glyph (retry that mark).
export type StageTap =
  | { kind: "tracks"; trackIds: TrackId[]; at: Point }
  | { kind: "empty"; at: Point }
  | { kind: "marker"; at: Point };

// The live stage overlay: track ghosts and set lines in live-frame
// coordinates, glued over the provider's (already visible) video.
// The wrapper math mirrors AnalysisView's, except the mapping is
// object-fit COVER (matching .camera-video), not contain — see
// coverTransform. Everything here is aria-hidden: SrLiveResults and
// the live region carry the accessible representation (the feedback
// sheets a tap opens render OUTSIDE this wrapper). Spoiler parity:
// below the "sets" reveal, App passes sets=[]/selected=null, so no
// set lines can render at all.
export function LiveView({
  tracks,
  liveSets,
  selected,
  colorFor,
  updateCount,
  degraded,
  markers,
  onTap,
}: {
  tracks: Track[];
  liveSets: LiveSet[];
  selected: SetIdentity | null;
  colorFor(id: SetIdentity): { color: string; dash: boolean };
  updateCount: number;
  degraded: boolean;
  markers: Point[]; // unresolved missed-card positions (frame coords)
  onTap(tap: StageTap): void;
}) {
  const { videoRef } = useCamera();
  const boxRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) =>
      setContainer({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // The video's intrinsic dimensions are stable once the stream is
  // live (LiveView only mounts after camera === "live", so metadata
  // has loaded); reading them per render is safe because live
  // updates re-render this component continuously anyway.
  const video = videoRef.current;
  const frame =
    video && video.videoWidth > 0
      ? clampedSize(
          video.videoWidth,
          video.videoHeight,
          LIVE_FRAME_MAX_DIMENSION,
        )
      : null;
  const t =
    frame && container.width > 0 ? coverTransform(frame, container) : null;

  // Tap dispatch (spec: hit-test the RENDERED elements, so what you
  // see mid-interpolation is what you tap): everything under the
  // point that carries data-track-id wins; an unresolved missed-card
  // marker wins over tracks; otherwise the tap is empty table unless
  // it grazed the edge grip zone.
  function handleClick(event: ReactMouseEvent<HTMLDivElement>) {
    const box = boxRef.current;
    if (!box || !frame) return;
    const rect = box.getBoundingClientRect();
    const point = { x: event.clientX, y: event.clientY };
    const hits = document.elementsFromPoint(point.x, point.y);
    for (const element of hits) {
      const marker = element
        .closest("[data-missed-marker]")
        ?.getAttribute("data-missed-marker");
      if (marker != null) {
        const at = markers[Number(marker)];
        if (at) onTap({ kind: "marker", at });
        return;
      }
    }
    const ids = new Set<number>();
    for (const element of hits) {
      const id = element
        .closest("[data-track-id]")
        ?.getAttribute("data-track-id");
      if (id != null) ids.add(Number(id));
    }
    const at = domToFrame(point, rect, frame);
    if (ids.size > 0) {
      onTap({ kind: "tracks", trackIds: [...ids].map(trackId), at });
    } else if (!inNoFireZone(point, rect)) {
      onTap({ kind: "empty", at });
    }
  }

  return (
    <div
      className="live-view"
      ref={boxRef}
      aria-hidden="true"
      onClick={handleClick}
    >
      {frame && t && (
        <div
          className="frame-space"
          style={{
            width: frame.width,
            height: frame.height,
            transform:
              `translate(${t.offsetX}px, ${t.offsetY}px) ` +
              `scale(${t.scale})`,
          }}
        >
          <TrackGhosts tracks={tracks} frameSize={frame} hitScale={t.scale} />
          {liveSets.length > 0 && (
            <LiveSetLines
              tracks={tracks}
              sets={liveSets}
              selected={selected}
              colorFor={colorFor}
              frameSize={frame}
            />
          )}
          {markers.map((at, index) => {
            // "couldn't read this one": renders until an roi-assist
            // track resolves the mark; a tap retries (once per tap)
            const size = Math.max(28, MIN_HIT_CLIENT_PX / t.scale);
            return (
              <div
                key={index}
                className="missed-marker"
                data-missed-marker={index}
                style={{
                  left: at.x - size / 2,
                  top: at.y - size / 2,
                  width: size,
                  height: size,
                  fontSize: size * 0.5,
                }}
              >
                ?
              </div>
            );
          })}
        </div>
      )}
      {/* freshness cue: remounts on every update (key) so the CSS
          pulse restarts; one step dimmer when the ladder is degraded */}
      <div
        key={updateCount}
        className={`fresh-pulse${degraded ? " degraded" : ""}`}
      />
    </div>
  );
}
