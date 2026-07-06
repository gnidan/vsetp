import { useEffect, useReducer, useRef, useState } from "react";
import type { Capture } from "../app/capture";
import { captureFromFile, captureFromVideo } from "../app/capture";
import { createCameraLifecycle } from "./camera-lifecycle";
import { cameraReduce } from "./camera-state";

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lifecycleRef = useRef(createCameraLifecycle());
  const [camera, send] = useReducer(cameraReduce, "unprimed");
  const [dismissed, setDismissed] = useState(false);
  const live = camera === "live";

  // a fresh notice (new guidance text, or notice appearing after
  // having been null) should reappear even if a prior one was
  // dismissed
  useEffect(() => setDismissed(false), [notice]);

  useEffect(() => {
    // setup() MUST re-mark mounted-ness: StrictMode replays this
    // effect (setup, cleanup, setup) on the same instance, and a
    // cleanup-only flag would poison every later getUserMedia grant
    lifecycleRef.current.setup();
    return () => {
      lifecycleRef.current.teardown();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function enableCamera() {
    send("enable");
    const token = lifecycleRef.current.beginEnable();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      // getUserMedia was pending across an unmount or a newer
      // enableCamera call: this grant is stale, so release it
      // immediately rather than adopting it into the ref.
      if (lifecycleRef.current.isStale(token)) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      // mid-session OS/browser revocation (e.g. the user pulls
      // camera permission, or another app claims the device): return
      // to the "Enable camera" path instead of a frozen live view.
      const [track] = stream.getVideoTracks();
      if (track) {
        track.onended = () => {
          if (streamRef.current !== stream) return; // superseded already
          streamRef.current = null;
          send("stopped");
        };
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      send("granted");
    } catch {
      send("denied");
    }
  }

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
    <section className="capture">
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
            <p className="notice">
              Camera unavailable or blocked. You can still take photos with the
              button below — it uses your system camera. To re-enable the live
              viewfinder, allow camera access in your browser settings and
              reload.
            </p>
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
      <video
        ref={videoRef}
        playsInline
        muted
        hidden={!active || !live}
        aria-label="Camera viewfinder"
      />
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
