import { useLayoutEffect, useRef, useState } from "react";
import { LIVE_FRAME_MAX_DIMENSION } from "../app/live-capture";
import { clampedSize } from "../app/capture";
import type { LiveSet } from "../app/live-sets";
import type { Track } from "../model";
import type { SetIdentity } from "../set/identity";
import { useCamera } from "./CameraProvider";
import { coverTransform } from "./homography";
import { LiveSetLines } from "./LiveSetLines";
import { TrackGhosts } from "./TrackGhosts";

// The live stage overlay: track ghosts and set lines in live-frame
// coordinates, glued over the provider's (already visible) video.
// The wrapper math mirrors AnalysisView's, except the mapping is
// object-fit COVER (matching .camera-video), not contain — see
// coverTransform. Everything here is aria-hidden: SrLiveResults and
// the live region carry the accessible representation. Spoiler
// parity: below the "sets" reveal, App passes sets=[]/selected=null,
// so no set lines can render at all.
export function LiveView({
  tracks,
  liveSets,
  selected,
  colorFor,
  updateCount,
  degraded,
}: {
  tracks: Track[];
  liveSets: LiveSet[];
  selected: SetIdentity | null;
  colorFor(id: SetIdentity): { color: string; dash: boolean };
  updateCount: number;
  degraded: boolean;
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

  return (
    <div className="live-view" ref={boxRef} aria-hidden="true">
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
          <TrackGhosts tracks={tracks} frameSize={frame} />
          {liveSets.length > 0 && (
            <LiveSetLines
              tracks={tracks}
              sets={liveSets}
              selected={selected}
              colorFor={colorFor}
              frameSize={frame}
            />
          )}
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
