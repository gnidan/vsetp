export type CameraState = "unprimed" | "starting" | "live" | "unavailable";
export type CameraEvent = "enable" | "granted" | "denied" | "stopped";

export function cameraReduce(
  state: CameraState,
  event: CameraEvent,
): CameraState {
  switch (event) {
    case "enable":
      return state === "unprimed" || state === "unavailable"
        ? "starting"
        : state;
    case "granted":
      return state === "starting" ? "live" : state;
    case "denied":
      return "unavailable";
    case "stopped":
      return "unprimed";
  }
}
