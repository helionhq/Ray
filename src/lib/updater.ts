import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { hasTauri } from "./bridge";

/** Check shortly after launch, then a few times a day. */
const FIRST_CHECK_MS = 5_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdatePhase = "idle" | "downloading" | "installing";

/** The outcome of one check, for callers that show a manual result. */
export type UpdateCheck =
  | { status: "available"; version: string }
  | { status: "current" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export interface UpdaterState {
  /** The version offered by the release endpoint, or null when up to date. */
  version: string | null;
  phase: UpdatePhase;
  /** 0–1 while downloading; null when the server sends no size. */
  progress: number | null;
  /** A failed installation, not a failed check. */
  error: string | null;
  /** True while an automatic or manual check is in flight. */
  checking: boolean;
}

export interface Updater extends UpdaterState {
  install: () => Promise<void>;
  checkNow: () => Promise<UpdateCheck>;
}

const idle: UpdaterState = {
  version: null,
  phase: "idle",
  progress: null,
  error: null,
  checking: false,
};

/** Dev servers and plain-browser previews must never query the release feed. */
export function updatesSupported(): boolean {
  return hasTauri() && !import.meta.env.DEV;
}

export function useUpdater(): Updater {
  const [state, setState] = useState<UpdaterState>(idle);
  const updateRef = useRef<Update | null>(null);
  const checkRef = useRef<Promise<UpdateCheck> | null>(null);
  const busyRef = useRef(false);

  const checkNow = useCallback(async (): Promise<UpdateCheck> => {
    if (!updatesSupported()) return { status: "unavailable" };
    if (updateRef.current) {
      return { status: "available", version: updateRef.current.version };
    }
    // Share one in-flight request between the automatic timer and the
    // Settings button instead of asking GitHub twice.
    if (checkRef.current) return checkRef.current;

    setState((current) => ({ ...current, checking: true }));

    const pending = (async (): Promise<UpdateCheck> => {
      try {
        const update = await check();
        if (!update) return { status: "current" };
        updateRef.current = update;
        setState((current) => ({ ...current, version: update.version }));
        return { status: "available", version: update.version };
      } catch (error) {
        // Offline, rate-limited, or no release published yet. The caller
        // decides whether to surface this; the automatic pass stays quiet.
        console.warn("[updater] check failed", error);
        return { status: "error", message: String(error) };
      } finally {
        setState((current) => ({ ...current, checking: false }));
      }
    })();

    checkRef.current = pending;
    try {
      return await pending;
    } finally {
      checkRef.current = null;
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void checkNow(), FIRST_CHECK_MS);
    const timer = window.setInterval(() => void checkNow(), CHECK_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [checkNow]);

  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update || busyRef.current) return;

    busyRef.current = true;
    setState((current) => ({
      ...current,
      phase: "downloading",
      progress: null,
      error: null,
    }));

    try {
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setState((current) =>
              current.phase === "downloading"
                ? {
                    ...current,
                    progress:
                      total > 0 ? Math.min(downloaded / total, 1) : null,
                  }
                : current,
            );
            break;
          case "Finished":
            setState((current) => ({
              ...current,
              phase: "installing",
              progress: null,
            }));
            break;
        }
      });
      // The NSIS installer usually closes Ray before this resolves; relaunch
      // covers the case where it hands control back to us.
      await relaunch();
    } catch (error) {
      busyRef.current = false;
      setState((current) => ({
        ...current,
        phase: "idle",
        progress: null,
        error: String(error),
      }));
    }
  }, []);

  return { ...state, install, checkNow };
}
