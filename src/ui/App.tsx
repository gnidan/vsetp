import { useEffect, useMemo, useReducer, useRef } from "react";
import type { Capture } from "../app/capture";
import { initialState, reduce } from "../app/state";
import { AnalyzeError, createWorkerClient } from "../app/worker-client";
import { AnalysisView } from "./AnalysisView";
import { CaptureView } from "./CaptureView";
import { ResultsPanel } from "./ResultsPanel";

export function App() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const client = useMemo(() => createWorkerClient(), []);
  const lastCapture = useRef<Capture | null>(null);

  const startEngine = useMemo(
    () => () =>
      client
        .init((loaded, total) =>
          dispatch({ type: "engine-progress", loaded, total }),
        )
        .then(() => dispatch({ type: "engine-ready" }))
        .catch((error: Error) =>
          dispatch({ type: "engine-failed", message: error.message }),
        ),
    [client],
  );

  useEffect(() => {
    // spec: eager init overlaps the download with framing — EXCEPT on
    // a metered connection (saveData), where the ~10MB fetch waits
    // for capture intent (startEngine is idempotent; onCapture calls
    // it again).
    const connection = (navigator as { connection?: { saveData?: boolean } })
      .connection;
    if (!connection?.saveData) void startEngine();
    return () => client.dispose();
  }, [client, startEngine]);

  // revoke the previous capture's display URL once replaced
  useEffect(() => {
    const current = state.screen.phase === "idle" ? null : state.screen.capture;
    if (lastCapture.current && lastCapture.current !== current) {
      lastCapture.current.revoke();
    }
    lastCapture.current = current;
  }, [state.screen]);

  function analyzeCapture(capture: Capture) {
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
    dispatch({ type: "captured", capture });
    void startEngine(); // no-op unless init was saveData-deferred
    analyzeCapture(capture);
  }

  const { engine, screen } = state;

  if (engine.status === "failed") {
    return (
      <main className="app">
        <h1>vsetp</h1>
        <p className="notice">
          The card reader couldn't start: {engine.message}. Check your
          connection and reload to retry.
        </p>
      </main>
    );
  }

  return (
    <main className="app">
      <h1>vsetp</h1>
      {engine.status === "loading" && (
        <p role="status" className="engine-progress">
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
          busyLabel={engine.status === "ready" ? "Analyzing…" : "Warming up…"}
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
          <ResultsPanel
            analysis={screen.analysis}
            triples={screen.triples}
            selected={screen.selected}
            onSelect={(index) => dispatch({ type: "select-set", index })}
            onRetake={() => dispatch({ type: "retake" })}
            onReanalyze={() => {
              const capture = screen.capture;
              dispatch({ type: "reanalyze" });
              analyzeCapture(capture);
            }}
          />
        </>
      )}
    </main>
  );
}
