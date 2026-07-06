import { useEffect, useRef, useState } from "react";
import type { Capture } from "../app/capture";
import { captureFromFile, captureFromVideo } from "../app/capture";

type CameraState = "unprimed" | "starting" | "live" | "unavailable";

export function CaptureView({
  notice,
  onCapture,
  onCaptureError,
}: {
  notice: string | null;
  onCapture(capture: Capture): void;
  onCaptureError(message: string): void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camera, setCamera] = useState<CameraState>("unprimed");

  useEffect(
    () => () => streamRef.current?.getTracks().forEach((t) => t.stop()),
    [],
  );

  async function enableCamera() {
    setCamera("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCamera("live");
    } catch {
      setCamera("unavailable");
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
      {notice && <p className="notice">{notice}</p>}
      {camera === "unprimed" && (
        <button className="primary" onClick={enableCamera}>
          Enable camera
        </button>
      )}
      {camera === "starting" && <p>Starting camera…</p>}
      <video
        ref={videoRef}
        playsInline
        muted
        hidden={camera !== "live"}
        aria-label="Camera viewfinder"
      />
      {camera === "live" && (
        <button className="primary shutter" onClick={shoot}>
          Analyze table
        </button>
      )}
      {camera === "unavailable" && (
        <p className="notice">
          Camera unavailable or blocked. You can still take photos with the
          button below — it uses your system camera. To re-enable the live
          viewfinder, allow camera access in your browser settings and reload.
        </p>
      )}
      <label className="picker">
        Choose or take a photo
        <input
          type="file"
          accept="image/*"
          onChange={(e) => void pick(e.target.files?.[0] ?? null)}
        />
      </label>
    </section>
  );
}
