import { useEffect, useReducer, useRef, useState } from "react";
import type { Capture } from "../app/capture";
import type { FeedbackLog } from "../app/feedback-log";
import { createFeedbackLog } from "../app/feedback-log";
import { installDecision, isIosSafari } from "../app/install";
import { createLiveCapturer } from "../app/live-capture";
import { createLiveDriver, createSchedule } from "../app/live-driver";
import { initialState, reduce } from "../app/state";
import type { WorkerClient } from "../app/worker-client";
import {
  AnalyzeError,
  DisposedError,
  createWorkerClient,
} from "../app/worker-client";
import type { Mark, Point } from "../model";
import { centroid } from "../worker/quad-utils";
import { LIVE_NUDGE_MS, announcementFor } from "./announce";
import { AnalysisView } from "./AnalysisView";
import { CameraProvider, useCamera } from "./CameraProvider";
import { CaptureView } from "./CaptureView";
import type { SheetRequest } from "./FeedbackSheet";
import { FeedbackSheet } from "./FeedbackSheet";
import { Hud, LiveHud } from "./Hud";
import type { StageTap } from "./LiveView";
import { LiveView } from "./LiveView";
import { PresenceBorder } from "./PresenceBorder";
import { createSetColorMap } from "./set-colors";
import { SrLiveResults, SrResults } from "./SrResults";

const INSTALL_DISMISSED_KEY = "vsetp-install-dismissed";

// Not in lib.dom.d.ts: the beforeinstallprompt event and its
// one-shot .prompt()/.userChoice contract are Chromium-only.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandaloneDisplay(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

// Copy by error class name, not raw message: an engine-init failure
// (bad network, bad WASM fetch) and a mid-session worker death read
// very differently to a user, even though both land in the same
// EngineState["failed"] shape.
function engineFailureMessage(error: Error): string {
  switch (error.name) {
    case "EngineInitError":
      return "The card reader couldn't load. Check your connection and retry.";
    case "WorkerDiedError":
    case "AnalyzeTimeoutError":
      return "The card reader stopped responding.";
    default:
      return error.message;
  }
}

export function App() {
  const [generation, setGeneration] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  // session feedback corpus: lives ABOVE Session (spec) so an engine
  // Retry — which remounts Session via key — preserves every mark
  const feedbackLogRef = useRef<FeedbackLog | null>(null);
  feedbackLogRef.current ??= createFeedbackLog();
  // a11y invariant: this aria-live region mounts exactly once and
  // NEVER remounts — including across Retry, which remounts Session
  // via key. Screen readers only track regions that persist; only
  // the TEXT may change. On retry the failure text stays until the
  // new Session's first announce effect lands.
  return (
    <>
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
      <CameraProvider>
        <Session
          key={generation}
          announce={setAnnouncement}
          feedbackLog={feedbackLogRef.current}
          onRetry={() => setGeneration((n) => n + 1)}
        />
      </CameraProvider>
    </>
  );
}

function Session({
  announce,
  feedbackLog,
  onRetry,
}: {
  announce(text: string): void;
  feedbackLog: FeedbackLog;
  onRetry(): void;
}) {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const { camera, videoRef } = useCamera();
  // ambient by default: the live session starts as soon as the
  // camera grants. "still" pauses it for the shutter flow — Task 6
  // wires the one-way stop; Task 7 owns the full serialized toggle.
  const [mode, setMode] = useState<"live" | "still">("live");
  // one feedback sheet at a time, opened by a live-stage tap
  const [sheet, setSheet] = useState<SheetRequest | null>(null);
  // session-scoped: identities keep their line colors across live
  // exits/re-entries within this Session (spec)
  const setColorsRef = useRef(createSetColorMap());
  const clientRef = useRef<WorkerClient | null>(null);
  const lastCapture = useRef<Capture | null>(null);
  const lastCountedCapture = useRef<Capture | null>(null);
  const deferredInstallPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  const [hasDeferredPrompt, setHasDeferredPrompt] = useState(false);
  const [successes, setSuccesses] = useState(0);
  const [installDismissed, setInstallDismissed] = useState(
    () => localStorage.getItem(INSTALL_DISMISSED_KEY) === "1",
  );

  const startEngine = (client: WorkerClient) =>
    client
      .init((loaded, total) =>
        dispatch({ type: "engine-progress", loaded, total }),
      )
      .then(() => dispatch({ type: "engine-ready" }))
      .catch((error: Error) => {
        // a disposed client's rejection is mount lifecycle
        // (StrictMode replay), not an engine failure
        if (error instanceof DisposedError) return;
        dispatch({
          type: "engine-failed",
          message: engineFailureMessage(error),
        });
      });

  useEffect(() => {
    // client-per-mount: dispose() poisons a client permanently
    // (sticky fatal), so StrictMode's mount-cleanup-remount must get
    // a fresh client each time. spec: eager init overlaps the
    // download with framing — EXCEPT on a metered connection
    // (saveData), where the ~10MB fetch waits for capture intent
    // (startEngine is idempotent; onCapture calls it again).
    const client = createWorkerClient();
    clientRef.current = client;
    const connection = (navigator as { connection?: { saveData?: boolean } })
      .connection;
    if (!connection?.saveData) void startEngine(client);
    return () => {
      client.dispose();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, []);

  // Live driver lifecycle: one driver per continuous live stretch.
  // Entry needs an idle screen (live-entered is phase-gated), but the
  // effect must NOT key on the phase alone — live-entered flips it to
  // "live", which would immediately tear the driver back down. So
  // wantLive stays true across idle → live and the driver runs until
  // the mode toggles, the camera drops, or the Session unmounts.
  const wantLive =
    mode === "live" &&
    camera === "live" &&
    (state.screen.phase === "idle" || state.screen.phase === "live");
  useEffect(() => {
    if (!wantLive) return;
    const client = clientRef.current;
    const video = videoRef.current;
    if (!client || !video) return;
    // driver-per-effect-run (the client-per-mount precedent): a
    // StrictMode replay stops the first driver in cleanup and starts
    // a fresh one, and the disposed first client's rejections are
    // lifecycle, not failures.
    const driver = createLiveDriver({
      client,
      video,
      capture: createLiveCapturer(),
      onUpdate: (update) => {
        // ROI outcome inference: a track the worker minted from the
        // user's missed-card assist resolves the nearest unresolved
        // mark (its marker glyph disappears on this same render)
        for (const track of update.tracks) {
          if (track.provenance === "roi-assist") {
            feedbackLog.noteRoiFound(centroid(track.quad), Date.now());
          }
        }
        dispatch({
          type: "live-update-received",
          tracks: update.tracks,
          at: Date.now(),
        });
      },
      onDegraded: (degraded) => dispatch({ type: "live-degraded", degraded }),
      onStall: () => {
        // a stalled driver stays "started" and never self-recovers:
        // stop it, then surface the failure overlay. Retry replaces
        // the Session (fresh driver); the camera survives via the
        // provider.
        void driver.stop();
        dispatch({
          type: "engine-failed",
          message: "The card reader stalled.",
        });
      },
      schedule: createSchedule(video),
      now: () => performance.now(),
    });
    dispatch({ type: "live-entered", at: Date.now() });
    const started = driver.start().catch((error: Error) => {
      if (error instanceof DisposedError) return; // mount lifecycle
      dispatch({
        type: "engine-failed",
        message: engineFailureMessage(error),
      });
    });
    return () => {
      // start() may still be in flight (StrictMode replay): chain the
      // stop behind it so the started session is always torn down
      void started.then(() => driver.stop()).catch(() => {});
      dispatch({ type: "live-left" });
    };
  }, [wantLive, videoRef, feedbackLog]);

  // sheets belong to the live stage: leaving it (mode toggle, stall,
  // camera drop) closes any open one
  const isLive = state.screen.phase === "live";
  useEffect(() => {
    if (!isLive) setSheet(null);
  }, [isLive]);

  // Slow-cadence re-announce while the live view sits empty: bump the
  // reducer's announceTick so announcementFor can alternate the
  // "No cards in view." text (see the comment there for why the text
  // itself must change).
  const liveEmpty =
    state.screen.phase === "live" && state.screen.tracks.length === 0;
  useEffect(() => {
    if (!liveEmpty) return;
    const timer = setInterval(
      () => dispatch({ type: "live-nudge" }),
      LIVE_NUDGE_MS,
    );
    return () => clearInterval(timer);
  }, [liveEmpty]);

  // push this session's announcement text up into App's persistent
  // live region (the region itself must never remount; see App)
  useEffect(() => {
    announce(announcementFor(state));
  }, [announce, state]);

  // revoke the previous capture's display URL once replaced
  useEffect(() => {
    const { screen } = state;
    const current =
      screen.phase === "analyzing" || screen.phase === "results"
        ? screen.capture
        : null;
    if (lastCapture.current && lastCapture.current !== current) {
      lastCapture.current.revoke();
    }
    lastCapture.current = current;
  }, [state.screen]);

  // contextual install CTA: hold the deferred prompt so it can be
  // fired later from the results-screen banner, never on load
  useEffect(() => {
    function onBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      deferredInstallPrompt.current = event as BeforeInstallPromptEvent;
      setHasDeferredPrompt(true);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () =>
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  // a success is an analysis-ok that reaches results with >=1 card;
  // counted once per capture (ref identity), so a reanalyze or
  // select-set re-fire on the same capture doesn't double-count. A
  // single slot suffices: every new capture is a fresh object, so
  // only the current one can repeat — and holding it adds no
  // retention beyond what the screen already keeps alive.
  useEffect(() => {
    const { screen } = state;
    if (
      screen.phase === "results" &&
      screen.analysis.cards.length > 0 &&
      lastCountedCapture.current !== screen.capture
    ) {
      lastCountedCapture.current = screen.capture;
      setSuccesses((n) => n + 1);
    }
  }, [state.screen]);

  function analyzeCapture(client: WorkerClient, capture: Capture) {
    client
      .analyze(capture.frame)
      .then((result) =>
        dispatch(
          result.status === "ok"
            ? { type: "analysis-ok", analysis: result.analysis }
            : {
                type: "analysis-superseded",
                frameId: capture.frame.id,
              },
        ),
      )
      .catch((error: Error) => {
        if (error instanceof DisposedError) return; // mount lifecycle
        dispatch(
          error instanceof AnalyzeError
            ? {
                type: "analysis-failed",
                stage: error.stage,
                message: error.message,
              }
            : {
                type: "engine-failed",
                message: engineFailureMessage(error),
              },
        );
      });
  }

  function onCapture(capture: Capture) {
    const client = clientRef.current;
    if (!client) return;
    // "captured" must dispatch before startEngine/analyze attach
    // their .then callbacks: reducer transitions run in dispatch
    // order, and both promises can already be settled (engine
    // warmed up earlier, analyze resolves fast) when this runs. If
    // startEngine's continuation attached first, a same-tick
    // engine-ready could interleave ahead of "captured" and the
    // analyzing screen would never have existed for analysis-ok to
    // land on. Attaching in this order guarantees engine-ready is
    // always observed before analysis-ok, whatever settles first.
    dispatch({ type: "captured", capture });
    void startEngine(client); // no-op unless init was saveData-deferred
    analyzeCapture(client, capture);
  }

  // A tap on the live stage, already hit-tested against the rendered
  // elements (LiveView): one track → card sheet; overlap → chooser;
  // open table → the explicit missed-card confirmation beat; an
  // unresolved marker → retry that mark (once per tap).
  function onStageTap(tap: StageTap) {
    const { screen } = state;
    if (screen.phase !== "live") return;
    switch (tap.kind) {
      case "tracks": {
        const hit = screen.tracks.filter((track) =>
          tap.trackIds.includes(track.trackId),
        );
        if (hit.length === 1) {
          setSheet({ kind: "card", track: hit[0], at: tap.at });
        } else if (hit.length > 1) {
          setSheet({ kind: "chooser", tracks: hit, at: tap.at });
        }
        return;
      }
      case "empty":
        setSheet({ kind: "empty", at: tap.at });
        return;
      case "marker":
        sendMark({ type: "missed-card", at: tap.at });
        dispatch({ type: "mark-confirmed", text: "Looking there again." });
        return;
    }
  }

  function sendMark(mark: Mark) {
    // best-effort delivery: a dying worker or a mid-stop race
    // surfaces through the driver's stall/failure paths, never here
    clientRef.current?.sendMark(mark).catch(() => {});
  }

  function confirmMark(mark: Mark, confirmation: string) {
    setSheet(null);
    feedbackLog.record(mark, Date.now());
    dispatch({ type: "mark-confirmed", text: confirmation });
    sendMark(mark);
  }

  function exportFeedbackLog() {
    const blob = new Blob([feedbackLog.toJson()], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `vsetp-feedback-${feedbackLog.entries().length}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function dismissInstallBanner() {
    localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
    setInstallDismissed(true);
  }

  async function onInstallClick() {
    const event = deferredInstallPrompt.current;
    if (!event) return;
    // a deferred prompt can only be triggered once
    deferredInstallPrompt.current = null;
    setHasDeferredPrompt(false);
    await event.prompt();
  }

  const install = installDecision({
    hasDeferredPrompt,
    isIos: isIosSafari(navigator.userAgent),
    isStandalone: isStandaloneDisplay(),
    dismissed: installDismissed,
    successes,
  });

  const { engine, screen, reveal } = state;

  // unresolved missed-card marks render as retryable glyphs; live
  // updates re-render this continuously, so reading the mutable log
  // during render stays fresh
  const missedMarkers: Point[] =
    screen.phase === "live"
      ? feedbackLog
          .entries()
          .flatMap((entry) =>
            entry.mark.type === "missed-card" && !entry.outcome
              ? [entry.mark.at]
              : [],
          )
      : [];

  return (
    <main className="app">
      {engine.status === "loading" && (
        <p className="engine-progress">
          Loading card reader…{" "}
          {engine.total
            ? `${Math.round((engine.loaded / engine.total) * 100)}%`
            : `${Math.round(engine.loaded / 1024 / 1024)}MB`}
        </p>
      )}
      {/* the stage (and the camera it displays via CameraProvider)
          stays mounted through an engine failure: only an overlay
          appears on top, so Retry never re-triggers a camera prompt */}
      <div className="stage">
        <CaptureView
          active={screen.phase === "idle"}
          notice={screen.phase === "idle" ? screen.notice : null}
          onCapture={onCapture}
          onCaptureError={(message) =>
            dispatch({ type: "capture-failed", message })
          }
        />
        {screen.phase === "analyzing" && (
          <AnalysisView
            capture={screen.capture}
            analysis={null}
            sets={[]}
            selected={null}
            busyLabel={engine.status === "ready" ? "Analyzing…" : "Warming up…"}
            onCancel={() => dispatch({ type: "cancel" })}
          />
        )}
        {screen.phase === "results" && (
          <>
            {/* spoiler parity: below the "sets" reveal, the
                overlay never receives set data at all */}
            <AnalysisView
              capture={screen.capture}
              analysis={screen.analysis}
              sets={reveal === "sets" ? screen.sets : []}
              selected={reveal === "sets" ? screen.selected : null}
              busyLabel={null}
            />
            {reveal === "presence" && (
              <PresenceBorder present={screen.sets.length > 0} />
            )}
            <div className="hud-stack">
              {install !== "none" && (
                <div className="notice install-banner">
                  {install === "prompt" ? (
                    <button
                      type="button"
                      className="install-action"
                      onClick={() => void onInstallClick()}
                    >
                      Install vsetp
                    </button>
                  ) : (
                    <span>
                      Add to Home Screen from the share menu to keep vsetp
                      handy.
                    </span>
                  )}
                  <button
                    type="button"
                    className="notice-dismiss"
                    aria-label="Dismiss install banner"
                    onClick={dismissInstallBanner}
                  >
                    ×
                  </button>
                </div>
              )}
              <Hud
                analysis={screen.analysis}
                sets={screen.sets}
                selected={screen.selected}
                reveal={reveal}
                onSelect={(id) => dispatch({ type: "select-set", id })}
                onReveal={(mode) => dispatch({ type: "set-reveal", mode })}
                onRetake={() => dispatch({ type: "retake" })}
                onReanalyze={() => {
                  const client = clientRef.current;
                  if (!client) return;
                  const capture = screen.capture;
                  dispatch({ type: "reanalyze" });
                  analyzeCapture(client, capture);
                }}
              />
            </div>
            <SrResults
              analysis={screen.analysis}
              sets={screen.sets}
              selected={screen.selected}
              revealSets={reveal === "sets"}
            />
          </>
        )}
        {screen.phase === "live" && (
          <>
            {/* spoiler parity at the App boundary: below the "sets"
                reveal, the live stage never receives set data at
                all; presence mode gets ONLY the debounced boolean */}
            <LiveView
              tracks={screen.tracks}
              liveSets={reveal === "sets" ? screen.liveSets : []}
              selected={reveal === "sets" ? screen.selected : null}
              colorFor={setColorsRef.current.colorFor}
              updateCount={screen.updateCount}
              degraded={screen.degraded}
              markers={missedMarkers}
              onTap={onStageTap}
            />
            {reveal === "presence" && (
              <PresenceBorder present={screen.presence.shown} />
            )}
            <div className="hud-stack">
              <LiveHud
                lockedCount={screen.lockedCount}
                hasSet={reveal === "presence" ? screen.presence.shown : false}
                setIds={
                  reveal === "sets" ? screen.liveSets.map((set) => set.id) : []
                }
                selected={reveal === "sets" ? screen.selected : null}
                reveal={reveal}
                toggleDisabled={false}
                onSelect={(id) => dispatch({ type: "select-set", id })}
                onReveal={(m) => dispatch({ type: "set-reveal", mode: m })}
                onToggleMode={() => setMode("still")}
                onExport={exportFeedbackLog}
              />
            </div>
            <SrLiveResults
              tracks={screen.tracks}
              liveSets={reveal === "sets" ? screen.liveSets : []}
              selected={reveal === "sets" ? screen.selected : null}
            />
            {sheet && (
              <FeedbackSheet
                request={sheet}
                onMark={confirmMark}
                onChoose={(track) =>
                  setSheet({ kind: "card", track, at: sheet.at })
                }
                onDismiss={() => setSheet(null)}
              />
            )}
          </>
        )}
      </div>
      {engine.status === "failed" && (
        <div className="failure-overlay">
          <p className="notice">{engine.message}</p>
          <button className="primary" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
    </main>
  );
}
