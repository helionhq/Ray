import { Fragment, useState } from "react";
import type { Provider, Settings, Snapshot, Theme } from "../lib/bridge";
import { api } from "../lib/bridge";
import { applyTheme } from "../lib/theme";
import { hotkeyLabel } from "../lib/format";
import {
  updatesSupported,
  type UpdateCheck,
  type Updater,
} from "../lib/updater";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronIcon,
  EyeIcon,
  EyeOffIcon,
} from "../components/Icons";

interface Props {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
  updater: Updater;
}

type Drafts = Record<Provider, string>;
type Reveals = Record<Provider, boolean>;
type ProviderFlags = Record<Provider, boolean>;

const emptyDrafts: Drafts = { assemblyai: "", groq: "", vercel: "" };
const hidden: Reveals = { assemblyai: false, groq: false, vercel: false };
const unflagged: ProviderFlags = {
  assemblyai: false,
  groq: false,
  vercel: false,
};

/** "gemma-4-31b (assemblyai)" reads as "gemma-4-31b" in the chain. */
function modelName(model: string): string {
  return model.replace(/\s*\([^)]*\)\s*$/, "");
}

export function SettingsPage({ snapshot, refresh, notify, updater }: Props) {
  const [drafts, setDrafts] = useState<Drafts>(emptyDrafts);
  const [reveals, setReveals] = useState<Reveals>(hidden);
  const [replacing, setReplacing] = useState<ProviderFlags>(unflagged);
  const [connected, setConnected] = useState<ProviderFlags>(unflagged);
  const [busy, setBusy] = useState<string | null>(null);
  const [checked, setChecked] = useState<UpdateCheck | null>(null);

  const saved = snapshot.keys;
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

  async function saveKey(provider: Provider) {
    const value = drafts[provider].trim();
    if (!value) return;
    setBusy(`save-${provider}`);
    try {
      await api.saveSecret(provider, value);
      setDrafts((current) => ({ ...current, [provider]: "" }));
      setReveals((current) => ({ ...current, [provider]: false }));
      setReplacing((current) => ({ ...current, [provider]: false }));
      setConnected((current) => ({ ...current, [provider]: false }));
      await refresh();
      notify("Key saved in Windows Credential Manager");
    } catch (error) {
      notify(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function testKey(provider: Provider) {
    setBusy(`test-${provider}`);
    try {
      if (drafts[provider].trim()) {
        await api.saveSecret(provider, drafts[provider].trim());
        setDrafts((current) => ({ ...current, [provider]: "" }));
        setReveals((current) => ({ ...current, [provider]: false }));
        setReplacing((current) => ({ ...current, [provider]: false }));
      }
      const message = await api.testSecret(provider);
      setConnected((current) => ({ ...current, [provider]: true }));
      notify(message);
      await refresh();
    } catch (error) {
      setConnected((current) => ({ ...current, [provider]: false }));
      notify(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function removeKey(provider: Provider) {
    setBusy(`remove-${provider}`);
    try {
      await api.clearSecret(provider);
      setConnected((current) => ({ ...current, [provider]: false }));
      setReplacing((current) => ({ ...current, [provider]: false }));
      setDrafts((current) => ({ ...current, [provider]: "" }));
      setReveals((current) => ({ ...current, [provider]: false }));
      await refresh();
      notify("Key removed");
    } catch (error) {
      notify(String(error));
    } finally {
      setBusy(null);
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

  function keyRow(
    provider: Provider,
    label: string,
    help: string,
    placeholder: string,
  ) {
    const isSaved = saved[provider];
    const isBusy = busy?.endsWith(provider) ?? false;
    const isReplacing = replacing[provider];
    const editing = !isSaved || isReplacing;

    return (
      <Fragment key={provider}>
        <div className="row">
          <div className="row-copy">
            <div className="label">
              {label}
              {connected[provider] && (
                <span className="ok">
                  <CheckIcon size={13} />
                  Connected
                </span>
              )}
            </div>
            <div className="help">{help}</div>
          </div>
          <div className="key">
            <span className={`badge${isSaved ? " is-saved" : ""}`}>
              {isSaved ? "Saved" : "Not set"}
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => void testKey(provider)}
              disabled={isBusy || (!isSaved && !drafts[provider].trim())}
            >
              {busy === `test-${provider}` ? "Testing…" : "Test"}
            </button>
            {isSaved && !isReplacing && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setReplacing((current) => ({ ...current, [provider]: true }))
                }
                disabled={isBusy}
              >
                Replace
              </button>
            )}
            {isSaved && !isReplacing && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void removeKey(provider)}
                disabled={isBusy}
              >
                Remove
              </button>
            )}
          </div>
        </div>
        {editing && (
          <div className="key-editor" key={`${provider}-editor`}>
            <div className="key-wrap">
              <input
                className="input"
                type={reveals[provider] ? "text" : "password"}
                value={drafts[provider]}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [provider]: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    drafts[provider].trim() &&
                    !isBusy
                  ) {
                    event.preventDefault();
                    void saveKey(provider);
                  }
                }}
                placeholder={
                  isSaved ? "Paste a new key" : placeholder
                }
                aria-label={`${label} API key`}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                className="reveal"
                onClick={() =>
                  setReveals((current) => ({
                    ...current,
                    [provider]: !current[provider],
                  }))
                }
                aria-label={reveals[provider] ? "Hide key" : "Show key"}
              >
                {reveals[provider] ? (
                  <EyeOffIcon size={14} />
                ) : (
                  <EyeIcon size={14} />
                )}
              </button>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => void saveKey(provider)}
              disabled={!drafts[provider].trim() || isBusy}
            >
              Save
            </button>
            {isReplacing && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setReplacing((current) => ({
                    ...current,
                    [provider]: false,
                  }));
                  setDrafts((current) => ({ ...current, [provider]: "" }));
                  setReveals((current) => ({ ...current, [provider]: false }));
                }}
                disabled={isBusy}
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </Fragment>
    );
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
            Keys stay in Windows Credential Manager. Only audio and text go to
            the services below.
          </p>
        </div>
      </header>

      <div className="group-label">Transcription</div>
      <div className="card">
        {keyRow(
          "assemblyai",
          "AssemblyAI",
          "Streaming speech-to-text, with batch upload as a fallback.",
          "Paste your AssemblyAI key",
        )}
        <div className="row">
          <div className="row-copy">
            <div className="label">Stream while I speak</div>
            <div className="help">Stopping only waits for the last few words.</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={snapshot.settings.streaming_enabled}
            aria-label="Stream while speaking"
            className="switch"
            disabled={busy !== null}
            onClick={() =>
              void update(
                { streaming_enabled: !snapshot.settings.streaming_enabled },
                "streaming",
              )
            }
          />
        </div>
      </div>

      <div className="group-label">Cleanup</div>
      <div className="card">
        <div className="row">
          <div className="row-copy">
            <div className="label">Clean up transcripts</div>
            <div className="help">
              Removes fillers and stutters, fixes punctuation, applies your
              dictionary.
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
        {keyRow(
          "groq",
          "Groq",
          "Fallback when the gateway is slow or busy.",
          "Paste your Groq key",
        )}
        <div className="row sub-row">
          <div className="chain">
            {snapshot.config.cleanup_models.map((model, index) => (
              <Fragment key={model}>
                {index > 0 && <ArrowRightIcon size={12} />}
                <span
                  className={`badge${index === 0 ? " primary" : ""}`}
                  title={model}
                >
                  {modelName(model)}
                </span>
              </Fragment>
            ))}
            {snapshot.config.cleanup_models.length > 0 && (
              <ArrowRightIcon size={12} />
            )}
            <span className="badge">raw transcript</span>
          </div>
        </div>
      </div>

      <div className="group-label">General</div>
      <div className="card">
        <div className="row">
          <div className="row-copy">
            <div className="label">Dictation shortcut</div>
            <div className="help">Press once to start, again to paste. Esc cancels.</div>
          </div>
          <kbd>{hotkeyLabel()}</kbd>
        </div>

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
        <dl className="facts">
          <div>
            <dt>Speech model</dt>
            <dd>{snapshot.config.speech_model}</dd>
          </div>
          <div>
            <dt>Cleanup chain</dt>
            <dd>{snapshot.config.cleanup_models.join(" → ")}</dd>
          </div>
          <div>
            <dt>Prompt</dt>
            <dd className="mono">{snapshot.config.prompt_source}</dd>
          </div>
          <div>
            <dt>Pipeline</dt>
            <dd className="mono">{snapshot.config.pipeline_source}</dd>
          </div>
        </dl>
        <div className="about-actions">
          <button
            type="button"
            className="btn btn-ghost"
            title="Reload pipeline.json and cleanup.md overrides"
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
