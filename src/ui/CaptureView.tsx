import { useEffect, useState } from "react";
import type { Capture } from "../app/capture";
import { captureFromFile, captureFromVideo } from "../app/capture";
import { useCamera } from "./CameraProvider";

export function CaptureView({
  active,
  notice,
  onCapture,
  onCaptureError,
}: {
  active: boolean;
  notice: string | null;
  onCapture(capture: Capture): void;
  onCaptureError(message: string): void;
}) {
  const { camera, videoRef, enableCamera } = useCamera();
  const [dismissed, setDismissed] = useState(false);
  const live = camera === "live";

  // a fresh notice (new guidance text, or notice appearing after
  // having been null) should reappear even if a prior one was
  // dismissed
  useEffect(() => setDismissed(false), [notice]);

  async function shoot() {
    if (!videoRef.current) return;
    try {
      onCapture(await captureFromVideo(videoRef.current));
    } catch (error) {
      onCaptureError(error instanceof Error ? error.message : "capture failed");
    }
  }

  async function pick(file: File | null) {
    if (!file) return;
    try {
      onCapture(await captureFromFile(file));
    } catch {
      onCaptureError("Couldn't read that image — try a JPEG or PNG photo.");
    }
  }

  return (
    <section className={`capture${live ? " live" : ""}`}>
      {active && !live && (
        <div className="capture-center">
          {notice && <p className="notice">{notice}</p>}
          {camera === "unprimed" && (
            <button className="primary" onClick={enableCamera}>
              Enable camera
            </button>
          )}
          {camera === "starting" && <p>Starting camera…</p>}
          {camera === "unavailable" && (
            <>
              <p className="notice">
                Camera unavailable or blocked. You can still take photos with
                the button below — it uses your system camera. To re-enable the
                live viewfinder, allow camera access in your browser settings
                and reload.
              </p>
              <button className="secondary" onClick={enableCamera}>
                Try again
              </button>
            </>
          )}
        </div>
      )}
      {active && live && notice && !dismissed && (
        <p className="notice capture-notice">
          {notice}
          <button
            type="button"
            className="notice-dismiss"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss notice"
          >
            ×
          </button>
        </p>
      )}
      {active && live && (
        <button className="primary shutter" onClick={shoot}>
          Analyze table
        </button>
      )}
      {active && (
        <label className="picker">
          <span>Choose or take a photo</span>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => void pick(e.target.files?.[0] ?? null)}
          />
        </label>
      )}
    </section>
  );
}
