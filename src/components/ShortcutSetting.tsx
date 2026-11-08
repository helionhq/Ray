import { Fragment, useEffect, useRef, useState } from "react";
import {
  api,
  onEvent,
  type Hotkey,
  type HotkeyCaptureError,
  type HotkeyView,
} from "../lib/bridge";

interface Props {
  notify: (message: string) => void;
}

/**
 * Settings row for the dictation shortcut. Capture happens in the Rust
 * keyboard hook (the webview never sees Right Alt / Win reliably), so this
 * component only starts capture, listens for the result, and persists it.
 */
export function ShortcutSetting({ notify }: Props) {
  const [view, setView] = useState<HotkeyView | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    let active = true;
    const unlisten: Array<() => void> = [];

    void api
      .getHotkey()
      .then((current) => {
        // Plain-browser previews have no IPC and resolve undefined.
        if (active && current) setView(current);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });

    void (async () => {
      const offCaptured = await onEvent<HotkeyView>(
        "hotkey-captured",
        (payload) => {
          void persist(payload.hotkey);
        },
      );
      const offError = await onEvent<HotkeyCaptureError>(
        "hotkey-capture-error",
        (payload) => {
          if (!active) return;
          setCapturing(false);
          setError(payload.message);
        },
      );
      const offChanged = await onEvent<HotkeyView>(
        "hotkey-changed",
        (payload) => {
          if (active) setView(payload);
        },
      );
      if (active) {
        unlisten.push(offCaptured, offError, offChanged);
      } else {
        offCaptured();
        offError();
        offChanged();
      }
    })();

    return () => {
      active = false;
      for (const off of unlisten) off();
      // Leaving Settings must not leave the hook swallowing every keystroke.
      void api.cancelHotkeyCapture();
    };
    // `persist` is stable enough for a listener registered once: it only uses
    // state setters and the notify ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function persist(hotkey: Hotkey) {
    try {
      const saved = await api.setHotkey(hotkey);
      setView(saved);
      setError(null);
      notifyRef.current(`Shortcut set to ${saved.label}`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setCapturing(false);
      setBusy(false);
    }
  }

  async function beginCapture() {
    setError(null);
    setBusy(true);
    try {
      await api.startHotkeyCapture();
      setCapturing(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function cancelCapture() {
    setCapturing(false);
    await api.cancelHotkeyCapture();
  }

  async function resetToDefault() {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.resetHotkey();
      setView(saved);
      notifyRef.current("Shortcut reset to Right Alt");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  const label = view?.label ?? "…";
  const caps = label.split(" + ");
  const disabled = busy || view === null;

  return (
    <div className="row shortcut-row">
      <div className="row-copy">
        <div className="label">Dictation shortcut</div>
        <div className="help">
          Press once to start, again to paste. Esc cancels.
        </div>
      </div>
      <div className="shortcut-control">
        {capturing ? (
          <span className="shortcut-capture" role="status" aria-live="polite">
            Press your new shortcut…
          </span>
        ) : (
          <span
            className="shortcut-keys"
            role="img"
            aria-label={`Current shortcut: ${label}`}
          >
            {caps.map((cap, index) => (
              <Fragment key={`${cap}-${index}`}>
                {index > 0 && (
                  <span className="shortcut-plus" aria-hidden="true">
                    +
                  </span>
                )}
                <kbd>{cap}</kbd>
              </Fragment>
            ))}
          </span>
        )}

        {capturing ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void cancelCapture()}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => void beginCapture()}
            disabled={disabled}
          >
            Change
          </button>
        )}

        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void resetToDefault()}
          disabled={disabled || capturing}
        >
          Reset to Right Alt
        </button>

        {error && (
          <div className="shortcut-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
