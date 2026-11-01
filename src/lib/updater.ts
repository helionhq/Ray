import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { hasTauri } from "./bridge";

/** Check shortly after launch, then a few times a day. */
const FIRST_CHECK_MS = 5_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Opening the window after a long tray stint should not wait for the timer. */
const FOCUS_CHECK_MS = 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

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
  const lastCheckAt = useRef(0);

  const checkNow = useCallback(async (): Promise<UpdateCheck> => {
    if (!updatesSupported()) return { status: "unavailable" };
    // An install owns the cached update until it finishes; replacing it then
    // would make a retry install something other than what the UI shows.
    if (busyRef.current) {
      const current = updateRef.current;
      return current
        ? { status: "available", version: current.version }
        : { status: "current" };
    }
    // Share one in-flight request between the automatic timer, the focus
    // check, and the Settings button instead of asking GitHub twice.
    if (checkRef.current) return checkRef.current;

    lastCheckAt.current = Date.now();
    setState((current) => ({ ...current, checking: true }));

    const pending = (async (): Promise<UpdateCheck> => {
      try {
        const update = await check({ timeout: CHECK_TIMEOUT_MS });
        // An install may have started while the feed was being queried. It
        // already captured the previous update, so keep that one on screen
        // and release the answer we no longer need.
        if (busyRef.current) {
          if (update) void update.close().catch(() => {});
          const current = updateRef.current;
          return current
            ? { status: "available", version: current.version }
            : { status: "current" };
        }
        // A tray app can run for days, so every completed check replaces the
        // cached answer (or clears it) instead of holding the first one.
        const previous = updateRef.current;
        updateRef.current = update;
        if (previous && previous !== update) {
          void previous.close().catch(() => {});
        }
        setState((current) => ({
          ...current,
          version: update?.version ?? null,
          // A successful check supersedes a stale install failure; the card
          // then offers the fresh update (or nothing) instead of "Retry".
          error: null,
        }));
        return update
          ? { status: "available", version: update.version }
          : { status: "current" };
      } catch (error) {
        // Offline, rate-limited, or no release published yet. The caller
        // decides whether to surface this; the automatic pass stays quiet.
        // Keep any cached update: a failed check is not proof it is gone.
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
    // A tray app can sit hidden for days; bring the check forward when the
    // user actually opens the window, at most once an hour.
    const onFocus = () => {
      if (Date.now() - lastCheckAt.current >= FOCUS_CHECK_MS) {
        void checkNow();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
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
      await update.downloadAndInstall(
        (event) => {
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
        },
        { timeout: DOWNLOAD_TIMEOUT_MS },
      );
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
