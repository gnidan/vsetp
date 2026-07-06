import { useEffect, useReducer, useRef } from "react";
import type { Capture } from "../app/capture";
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
import { SrResults } from "./SrResults";

export function App() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const clientRef = useRef<WorkerClient | null>(null);
  const lastCapture = useRef<Capture | null>(null);

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
        dispatch({ type: "engine-failed", message: error.message });
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
      .catch((error: Error) =>
        dispatch(
          error instanceof AnalyzeError
            ? {
                type: "analysis-failed",
                stage: error.stage,
                message: error.message,
              }
            : { type: "engine-failed", message: error.message },
        ),
      );
  }

  function onCapture(capture: Capture) {
    const client = clientRef.current;
    if (!client) return;
    dispatch({ type: "captured", capture });
    void startEngine(client); // no-op unless init was saveData-deferred
    analyzeCapture(client, capture);
  }

  const { engine, screen } = state;

  return (
    <main className="app">
      <div aria-live="polite" role="status" className="sr-only">
        {announcementFor(state)}
      </div>
      {engine.status === "failed" ? (
        <p className="notice">
          The card reader couldn't start: {engine.message}. Check your
          connection and reload to retry.
        </p>
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
          {screen.phase === "idle" && (
            <CaptureView
              notice={screen.notice}
              onCapture={onCapture}
              onCaptureError={(message) =>
                dispatch({ type: "capture-failed", message })
              }
            />
          )}
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
              <AnalysisView
                capture={screen.capture}
                analysis={screen.analysis}
                triples={screen.triples}
                selected={screen.selected}
                busyLabel={null}
              />
              <Hud
                analysis={screen.analysis}
                triples={screen.triples}
                selected={screen.selected}
                onSelect={(index) => dispatch({ type: "select-set", index })}
                onRetake={() => dispatch({ type: "retake" })}
                onReanalyze={() => {
                  const client = clientRef.current;
                  if (!client) return;
                  const capture = screen.capture;
                  dispatch({ type: "reanalyze" });
                  analyzeCapture(client, capture);
                }}
              />
              <SrResults
                analysis={screen.analysis}
                triples={screen.triples}
                selected={screen.selected}
              />
            </>
          )}
        </>
      )}
    </main>
  );
}
