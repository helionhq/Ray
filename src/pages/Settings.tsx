import { useState } from "react";
import type { Settings, Snapshot, Theme } from "../lib/bridge";
import { api } from "../lib/bridge";
import { applyTheme } from "../lib/theme";
import { ShortcutSetting } from "../components/ShortcutSetting";
import {
  updatesSupported,
  type UpdateCheck,
  type Updater,
} from "../lib/updater";
import { ChevronIcon } from "../components/Icons";

interface Props {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
  updater: Updater;
}

export function SettingsPage({ snapshot, refresh, notify, updater }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [checked, setChecked] = useState<UpdateCheck | null>(null);

  const canCheck = updatesSupported();
  const checking = updater.checking;
  const updateBusy = updater.phase !== "idle";

  let updateHelp = "Local dictation for Windows.";
  if (!canCheck) {
    updateHelp = "Update checks run in the installed app.";
  } else if (updater.error) {
    updateHelp = "The update could not be installed. Try again.";
  } else if (updater.phase === "downloading") {
    updateHelp = `Downloading Ray ${updater.version}…`;
  } else if (updater.phase === "installing") {
    updateHelp = "Installing. Ray will restart when it is done.";
  } else if (updater.version) {
    updateHelp = `Ray ${updater.version} is ready to install. Ray will restart when it is done.`;
  } else if (checking) {
    updateHelp = "Looking for a new version…";
  } else if (checked?.status === "current") {
    updateHelp = "Ray is up to date.";
  } else if (checked?.status === "error") {
    updateHelp = "Couldn't check for updates. Try again.";
  }

  let updateLabel = "Install update";
  if (updater.error) {
    updateLabel = "Retry";
  } else if (updater.phase === "downloading") {
    updateLabel =
      updater.progress === null
        ? "Downloading…"
        : `${Math.round(updater.progress * 100)}%`;
  } else if (updater.phase === "installing") {
    updateLabel = "Installing…";
  }

  async function checkForUpdates() {
    setChecked(null);
    try {
      const result = await updater.checkNow();
      setChecked(result);
      if (result.status === "current") {
        notify("Ray is up to date");
      } else if (result.status === "available") {
        notify(`Ray ${result.version} is available`);
      } else if (result.status === "error") {
        notify("Couldn't check for updates");
      }
    } catch (error) {
      setChecked({ status: "error", message: String(error) });
      notify("Couldn't check for updates");
    }
  }

  async function retryHotkey() {
    setBusy("hotkey");
    try {
      await api.retryHotkey();
      await refresh();
      notify("Keyboard hook restarted");
    } catch (error) {
      notify(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function update(patch: Partial<Settings>, id: string) {
    setBusy(id);
    try {
      // The registry-derived value is the truth for launch-at-login; the copy
      // in the store can be stale if the Run key was changed outside Ray.
      await api.saveSettings({
        ...snapshot.settings,
        launch_at_login: snapshot.launch_at_login,
        ...patch,
      });
      await refresh();
    } catch (error) {
      notify(String(error));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function setTheme(theme: Theme) {
    if (theme === snapshot.settings.theme || busy !== null) return;
    applyTheme(theme);
    setBusy("theme");
    try {
      await api.saveSettings({
        ...snapshot.settings,
        launch_at_login: snapshot.launch_at_login,
        theme,
      });
      await refresh();
    } catch (error) {
      applyTheme(snapshot.settings.theme);
      notify(String(error));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const devices = snapshot.devices;
  const selectedDevice = snapshot.settings.input_device;
  const hasSelected =
    !selectedDevice || devices.some((device) => device.id === selectedDevice);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">
            Everything stays on this PC. Only audio and text go to Ray.
          </p>
        </div>
      </header>

      <div className="group-label">Cleanup</div>
      <div className="card">
        <div className="row">
          <div className="row-copy">
            <div className="label">Clean up transcripts</div>
            <div className="help">
              Rewrites speech for flow, with paragraphs and lists.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={snapshot.settings.cleanup_enabled}
            aria-label="Clean up transcripts"
            className="switch"
            disabled={busy !== null}
            onClick={() =>
              void update(
                { cleanup_enabled: !snapshot.settings.cleanup_enabled },
                "cleanup",
              )
            }
          />
        </div>
      </div>

      <div className="group-label">General</div>
      <div className="card">
        <ShortcutSetting notify={notify} />

        <div className="row">
          <div className="row-copy">
            <div className="label">Microphone</div>
          </div>
          <div className="select">
            <select
              value={selectedDevice ?? ""}
              disabled={busy !== null}
              onChange={(event) =>
                void update(
                  { input_device: event.target.value || null },
                  "mic",
                )
              }
              aria-label="Microphone"
            >
              <option value="">System default</option>
              {!hasSelected && selectedDevice && (
                <option value={selectedDevice}>
                  Selected microphone (unavailable)
                </option>
              )}
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                  {device.is_default ? "  ·  default" : ""}
                </option>
              ))}
            </select>
            <ChevronIcon size={12} />
          </div>
        </div>

        <div className="row">
          <div className="row-copy">
            <div className="label">Launch at login</div>
            <div className="help">Keep Ray ready in the tray.</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={snapshot.launch_at_login}
            aria-label="Launch at login"
            className="switch"
            disabled={busy !== null}
            onClick={() =>
              void update(
                { launch_at_login: !snapshot.launch_at_login },
                "autostart",
              )
            }
          />
        </div>

        <div className="row">
          <div className="row-copy">
            <div className="label">Keep original transcripts</div>
            <div className="help">Save the uncleaned text next to each dictation.</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={snapshot.settings.keep_raw}
            aria-label="Keep original transcripts"
            className="switch"
            disabled={busy !== null}
            onClick={() =>
              void update({ keep_raw: !snapshot.settings.keep_raw }, "raw")
            }
          />
        </div>

        <div className="row">
          <div className="row-copy">
            <div className="label">Appearance</div>
          </div>
          <div className="segmented" role="group" aria-label="Appearance">
            {(["system", "light", "dark"] as const).map((theme) => (
              <button
                key={theme}
                type="button"
                aria-pressed={snapshot.settings.theme === theme}
                disabled={busy === "theme"}
                onClick={() => void setTheme(theme)}
              >
                {theme === "system"
                  ? "System"
                  : theme === "light"
                    ? "Light"
                    : "Dark"}
              </button>
            ))}
          </div>
        </div>

        {snapshot.hotkey_error && (
          <div className="row">
            <div className="row-copy">
              <div className="label">Keyboard shortcut unavailable</div>
              <div className="help">{snapshot.hotkey_error}</div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => void retryHotkey()}
              disabled={busy !== null}
            >
              {busy === "hotkey" ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
      </div>

      <div className="group-label">About</div>
      <div className="card">
        <div className="row">
          <div className="row-copy">
            <div className="label">Ray {snapshot.version}</div>
            <div className="help" aria-live="polite">
              {updateHelp}
            </div>
          </div>
          {updater.version ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void updater.install()}
              disabled={updateBusy}
            >
              {updateLabel}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() => void checkForUpdates()}
              disabled={!canCheck || checking}
            >
              {checking ? "Checking…" : "Check for updates"}
            </button>
          )}
        </div>
        <div className="about-actions">
          <button
            type="button"
            className="btn btn-ghost"
            title="Reload pipeline.json and structured.md overrides"
            onClick={async () => {
              try {
                await api.reloadConfig();
                await refresh();
                notify("Configuration reloaded");
              } catch (error) {
                notify(String(error));
              }
            }}
          >
            Reload config
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void api.quit()}
          >
            Quit Ray
          </button>
        </div>
      </div>
    </>
  );
}
