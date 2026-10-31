import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onEvent } from "../lib/bridge";
import { DotScope, type BarPhase } from "./dotScope";

interface BarState {
  phase?: BarPhase;
  message?: string;
}

/** Hex's synthetic voice: phrases of syllables with breaths between. */
function demoLevel(time: number) {
  const phrase = Math.floor(time / 2.4);
  const t = time - phrase * 2.4;
  if (t > 1.7) return 0.04;
  const shape = Math.sin((Math.PI * t) / 1.7) ** 0.4;
  const rate = 2 * Math.PI * (4.3 + 0.6 * Math.sin(phrase * 1.7));
  const syllable = 0.5 + 0.5 * Math.sin(rate * t + phrase);
  const stress = 0.75 + 0.25 * Math.sin(2 * Math.PI * 1.1 * t + 2 * phrase);
  return Math.max(0, Math.min(1, 0.08 + 0.82 * shape * syllable ** 1.6 * stress));
}

export function Bar() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const scope = new DotScope(element);
    void invoke<BarState>("get_bar_state")
      .then((state) => {
        if (state?.phase) scope.setPhase(state.phase);
      })
      .catch(() => {});

    const unlisteners = [
      onEvent<BarState>("bar-state", (state) => {
        if (state?.phase) scope.setPhase(state.phase);
      }),
      onEvent<number>("bar-level", (level) => scope.setLevel(level)),
    ];

    // Browser-only preview: bar.html?phase=recording&theme=dark
    if (!("__TAURI_INTERNALS__" in window)) {
      const params = new URLSearchParams(window.location.search);
      const phase = params.get("phase") as BarPhase | null;
      if (phase === "done") {
        scope.preview("processing", 0.75);
        scope.preview("done", 0.18);
      } else if (phase === "error") {
        scope.preview("recording", 0.7, demoLevel);
        scope.preview("error", 0.5);
      } else if (phase) {
        scope.preview(phase, 1.6, phase === "recording" ? demoLevel : undefined);
      }
    }

    return () => {
      scope.destroy();
      for (const unlisten of unlisteners) void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="bar-stage">
      <canvas ref={canvas} aria-hidden="true" />
    </div>
  );
}
