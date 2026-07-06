import { useEffect, useReducer, useRef, useState } from "react";
import type { Capture } from "../app/capture";
import { installDecision, isIosSafari } from "../app/install";
import { initialState, reduce } from "../app/state";
import type { WorkerClient } from "../app/worker-client";
import {
  AnalyzeError,
  DisposedError,
  createWorkerClient,
} from "../app/worker-client";
import { announcementFor } from "./announce";
import { AnalysisView } from "./AnalysisView";
import { CaptureView } from "./CaptureView";
import { Hud } from "./Hud";
import { PresenceBorder } from "./PresenceBorder";
import { SrResults } from "./SrResults";

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
  return (
    <Session key={generation} onRetry={() => setGeneration((n) => n + 1)} />
  );
}

function Session({ onRetry }: { onRetry(): void }) {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
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

  // revoke the previous capture's display URL once replaced
  useEffect(() => {
    const current = state.screen.phase === "idle" ? null : state.screen.capture;
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

  return (
    <main className="app">
      <div aria-live="polite" role="status" className="sr-only">
        {announcementFor(state)}
      </div>
      {engine.status === "failed" ? (
        <div className="capture-center">
          <p className="notice">{engine.message}</p>
          <button className="primary" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : (
        <>
          {engine.status === "loading" && (
            <p className="engine-progress">
              Loading card reader…{" "}
              {engine.total
                ? `${Math.round((engine.loaded / engine.total) * 100)}%`
                : `${Math.round(engine.loaded / 1024 / 1024)}MB`}
            </p>
          )}
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
                triples={[]}
                selected={-1}
                busyLabel={
                  engine.status === "ready" ? "Analyzing…" : "Warming up…"
                }
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
                  triples={reveal === "sets" ? screen.triples : []}
                  selected={reveal === "sets" ? screen.selected : -1}
                  busyLabel={null}
                />
                {reveal === "presence" && (
                  <PresenceBorder present={screen.triples.length > 0} />
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
                    triples={screen.triples}
                    selected={screen.selected}
                    reveal={reveal}
                    onSelect={(index) =>
                      dispatch({ type: "select-set", index })
                    }
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
                  triples={screen.triples}
                  selected={screen.selected}
                  revealSets={reveal === "sets"}
                />
              </>
            )}
          </div>
        </>
      )}
    </main>
  );
}
