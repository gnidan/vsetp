import { useLayoutEffect, useRef, useState } from "react";
import type { Capture } from "../app/capture";
import type { FrameAnalysis } from "../model";
import type { SetTriple } from "../set";
import { displayTransform } from "./homography";
import { Overlay } from "./Overlay";

export function AnalysisView({
  capture,
  analysis,
  triples,
  selected,
  busyLabel,
  onCancel,
}: {
  capture: Capture;
  analysis: FrameAnalysis | null; // null while analyzing
  triples: SetTriple[];
  selected: number;
  busyLabel: string | null;
  onCancel?: () => void;
}) {
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

  const t = displayTransform(capture, container);
  return (
    <div className="analysis-view" ref={boxRef}>
      <div
        className="frame-space"
        style={{
          width: capture.width,
          height: capture.height,
          transform:
            `translate(${t.offsetX}px, ${t.offsetY}px) ` + `scale(${t.scale})`,
        }}
      >
        <img
          src={capture.displayUrl}
          alt="Captured table"
          width={capture.width}
          height={capture.height}
        />
        {analysis && (
          <Overlay analysis={analysis} triples={triples} selected={selected} />
        )}
        {busyLabel && (
          // no role="status" here: the persistent live region in App
          // owns announcements, and a second one would double-speak
          <div className="busy">
            <p>{busyLabel}</p>
            {onCancel && <button onClick={onCancel}>Cancel</button>}
          </div>
        )}
      </div>
    </div>
  );
}
