import { useEffect, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { hasTauri } from "../lib/bridge";

/**
 * The main window is undecorated, so this draws the caption: a drag strip in
 * the app's own palette plus Windows-style minimise / maximise / close.
 * Close goes through the normal close request, which Ray turns into "hide to
 * tray".
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!hasTauri()) return;
    const window = getCurrentWindow();
    let disposed = false;
    const sync = () =>
      void window
        .isMaximized()
        .then((value) => !disposed && setMaximized(value))
        .catch(() => {});
    sync();
    const unlisten = window.onResized(sync);
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const act = (action: "minimize" | "toggleMaximize" | "close") => {
    if (!hasTauri()) return;
    void getCurrentWindow()[action]().catch(() => {});
  };

  return (
    <div className="titlebar" onMouseDown={startDrag} onDoubleClick={toggleOnDoubleClick}>
      <div className="window-controls">
        <button
          type="button"
          className="window-control"
          aria-label="Minimize"
          onClick={() => act("minimize")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5.5h10" stroke="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="window-control"
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={() => act("toggleMaximize")}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z"
                fill="none"
                stroke="currentColor"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M.5.5h9v9h-9z" fill="none" stroke="currentColor" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="window-control is-close"
          aria-label="Close"
          onClick={() => act("close")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** Drag the window from any non-interactive part of a caption area. */
export function startDrag(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0 || event.detail > 1 || !hasTauri()) return;
  if ((event.target as HTMLElement).closest("button, a, input, select, textarea")) return;
  void getCurrentWindow().startDragging().catch(() => {});
}

export function toggleOnDoubleClick(event: MouseEvent<HTMLElement>) {
  if (!hasTauri()) return;
  if ((event.target as HTMLElement).closest("button, a, input, select, textarea")) return;
  void getCurrentWindow().toggleMaximize().catch(() => {});
}
