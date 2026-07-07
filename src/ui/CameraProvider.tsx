import type { ReactNode, RefObject } from "react";
import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from "react";
import { createCameraLifecycle } from "./camera-lifecycle";
import type { CameraState } from "./camera-state";
import { cameraReduce } from "./camera-state";

export interface CameraContextValue {
  camera: CameraState;
  // useRef<HTMLVideoElement>(null) types as RefObject<T | null> under
  // this @types/react version (there is no non-nullable overload for
  // a null initial value) — matching that exactly here, rather than
  // the brief's literal RefObject<HTMLVideoElement>, avoids a cast.
  videoRef: RefObject<HTMLVideoElement | null>;
  enableCamera(): void;
}

export const CameraContext = createContext<CameraContextValue | null>(null);

// CaptureView (Still shoot()) and the live driver both need the one
// video element; this throws instead of silently degrading if either
// ever renders outside the provider.
export function useCamera(): CameraContextValue {
  const value = useContext(CameraContext);
  if (!value) {
    throw new Error("useCamera must be used within a CameraProvider");
  }
  return value;
}

// Hoisted above <Session key={generation}> so an engine Retry (which
// remounts Session) never re-prompts for camera permission: the
// stream, the reducer, and the <video> element all outlive it.
export function CameraProvider({ children }: { children: ReactNode }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lifecycleRef = useRef(createCameraLifecycle());
  const [camera, send] = useReducer(cameraReduce, "unprimed");

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

  return (
    <CameraContext.Provider value={{ camera, videoRef, enableCamera }}>
      {/* stage-filling regardless of where in the tree this renders
          (see .camera-video: fixed, inset by the same safe-area env()
          vars .app's padding uses, so it lines up with .stage without
          being its DOM descendant) */}
      <video
        ref={videoRef}
        playsInline
        muted
        hidden={camera !== "live"}
        aria-label="Camera viewfinder"
        className="camera-video"
      />
      {children}
    </CameraContext.Provider>
  );
}
