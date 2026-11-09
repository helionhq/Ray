import { useEffect, useState } from "react";
import { api, hasTauri, onEvent } from "../lib/bridge";
import { RayLogo } from "../components/RayLogo";
import { TitleBar, startDrag, toggleOnDoubleClick } from "../components/TitleBar";

type Phase = "idle" | "waiting" | "error";

/**
 * The signed-out main window. Sign-in happens in the system browser (Google
 * blocks OAuth in embedded webviews), so the waiting state has to survive the
 * user leaving Ray in the foreground until the deep link comes back.
 */
export function SignInScreen() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = onEvent<string>("auth-error", (message) => {
      setError(message);
      setPhase("error");
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  async function start() {
    setError(null);
    setPhase("waiting");
    try {
      await api.signIn();
    } catch (caught) {
      setError(String(caught));
      setPhase("error");
    }
  }

  async function cancel() {
    try {
      await api.cancelSignIn();
    } catch {
      // Cancelling is best-effort; the browser tab is the user's to close.
    }
    setPhase("idle");
  }

  return (
    <div className="boot-screen signin-screen">
      <TitleBar />
      <div
        className="signin"
        onMouseDown={startDrag}
        onDoubleClick={toggleOnDoubleClick}
      >
        <RayLogo />
        <h1>Sign in to start dictating</h1>
        <p className="signin-copy">
          Ray uses your account for transcription and cleanup. Ray's servers
          never store your audio or transcripts, and your History stays on this
          PC.
        </p>

        {phase === "waiting" ? (
          <div className="signin-waiting" role="status">
            <span className="status-spinner" aria-hidden="true" />
            Waiting for your browser…
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-primary signin-button"
            onClick={() => void start()}
          >
            {phase === "error" ? "Try again" : "Sign in"}
          </button>
        )}

        {phase === "waiting" && (
          <>
            <button type="button" className="btn btn-ghost" onClick={() => void cancel()}>
              Cancel
            </button>
            <span className="signin-hint">
              Finish signing in in your browser, then come back to Ray.
            </span>
          </>
        )}

        {phase === "error" && error && (
          <p className="signin-error" role="alert">
            {error}
          </p>
        )}

        {!hasTauri() && (
          <span className="signin-hint">Open the Ray app to sign in.</span>
        )}
      </div>
    </div>
  );
}
