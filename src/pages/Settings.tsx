import { useState } from "react";
import type { Provider, Settings, Snapshot } from "../lib/bridge";
import { api } from "../lib/bridge";
import {
  ChevronIcon,
  EyeIcon,
  EyeOffIcon,
  KeyboardIcon,
} from "../components/Icons";
import { hotkeyLabel } from "../lib/format";

interface Props {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}

type Drafts = Record<Provider, string>;
type Reveals = Record<Provider, boolean>;

const emptyDrafts: Drafts = { assemblyai: "", groq: "", vercel: "" };
const hidden: Reveals = { assemblyai: false, groq: false, vercel: false };

export function SettingsPage({ snapshot, refresh, notify }: Props) {
  const [drafts, setDrafts] = useState<Drafts>(emptyDrafts);
  const [reveals, setReveals] = useState<Reveals>(hidden);
  const [busy, setBusy] = useState<string | null>(null);

  const saved = snapshot.keys;

  async function saveKey(provider: Provider) {
    const value = drafts[provider].trim();
    if (!value) return;
    setBusy(`save-${provider}`);
    try {
      await api.saveSecret(provider, value);
      setDrafts((current) => ({ ...current, [provider]: "" }));
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
      }
      const message = await api.testSecret(provider);
      notify(message);
      await refresh();
    } catch (error) {
      notify(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function removeKey(provider: Provider) {
    setBusy(`remove-${provider}`);
    try {
      await api.clearSecret(provider);
      await refresh();
      notify("Key removed");
    } catch (error) {
      notify(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function update(patch: Partial<Settings>, id: string) {
    setBusy(id);
    try {
      await api.saveSettings({ ...snapshot.settings, ...patch });
      await refresh();
    } catch (error) {
      notify(String(error));
    } finally {
      setBusy(null);
    }
  }

  function keyEditor(
    provider: Provider,
    label: string,
    help: string,
    placeholder: string,
  ) {
    const isSaved = saved[provider];
    const isBusy = busy?.endsWith(provider) ?? false;
    return (
      <div className="key-block" key={provider}>
        <div className="key-head">
          <div>
            <div className="setting-label">{label}</div>
            <div className="setting-help">{help}</div>
          </div>
          <span className="key-state">{isSaved ? "Saved" : "Not set"}</span>
        </div>
        <div className="key-field">
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
              placeholder={isSaved ? "••••••••••••••••  saved" : placeholder}
              aria-label={`${label} API key`}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              className="reveal"
              onClick={() =>
                setReveals((current) => ({
                  ...current,
                  [provider]: !current[provider],
                }))
              }
              aria-label={reveals[provider] ? "Hide key" : "Show key"}
              type="button"
            >
              {reveals[provider] ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
            </button>
          </div>
          <button
            className="btn"
            onClick={() => void saveKey(provider)}
            disabled={!drafts[provider].trim() || isBusy}
          >
            Save
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void testKey(provider)}
            disabled={isBusy || (!drafts[provider].trim() && !isSaved)}
          >
            {busy === `test-${provider}` ? "Testing…" : "Test"}
          </button>
          {isSaved && (
            <button
              className="btn btn-ghost"
              onClick={() => void removeKey(provider)}
              disabled={isBusy}
            >
              Remove
            </button>
          )}
        </div>
      </div>
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
            Keys stay in Windows Credential Manager. Nothing here leaves this PC
            except the audio and text sent to the services you choose.
          </p>
        </div>
      </header>

      <section className="card section">
        <div className="section-head">
          <div>
            <div className="section-title">Transcription</div>
            <div className="section-desc">
              AssemblyAI turns your voice into text.
            </div>
          </div>
          <span className="section-badge">{snapshot.config.speech_model}</span>
        </div>
        {keyEditor(
          "assemblyai",
          "AssemblyAI API key",
          "Used for streaming speech-to-text and the batch fallback.",
          "Paste your AssemblyAI key",
        )}
        <div className="setting-row">
          <div>
            <div className="setting-label">Stream while I speak</div>
            <div className="setting-help">
              Transcribes during recording so stopping only waits for the last
              few words. Falls back to an upload automatically.
            </div>
          </div>
          <button
            role="switch"
            aria-checked={snapshot.settings.streaming_enabled}
            aria-label="Stream while speaking"
            className="switch"
            disabled={busy === "streaming"}
            onClick={() =>
              void update(
                { streaming_enabled: !snapshot.settings.streaming_enabled },
                "streaming",
              )
            }
          />
        </div>
      </section>

      <section className="card section">
        <div className="section-head">
          <div>
            <div className="section-title">Cleanup</div>
            <div className="section-desc">
              Removes fillers, fixes punctuation, and applies your dictionary.
              The primary model runs on the AssemblyAI LLM Gateway with the key
              above.
            </div>
          </div>
          <button
            role="switch"
            aria-checked={snapshot.settings.cleanup_enabled}
            aria-label="Clean up transcripts"
            className="switch"
            disabled={busy === "cleanup"}
            onClick={() =>
              void update(
                { cleanup_enabled: !snapshot.settings.cleanup_enabled },
                "cleanup",
              )
            }
          />
        </div>
        {keyEditor(
          "groq",
          "Groq API key",
          "First fallback; the fastest cleanup path when the gateway is busy.",
          "Paste your Groq key",
        )}
        {keyEditor(
          "vercel",
          "Vercel AI Gateway key",
          "Optional third provider. Used only if the first two fail.",
          "Paste your AI Gateway key",
        )}
        <div className="setting-row setting-row-stack">
          <div className="setting-help">
            Model chain: {snapshot.config.cleanup_models.join("  →  ")}
          </div>
          <div className="setting-help">
            If every provider fails, Ray pastes the raw transcript rather than
            losing your words.
          </div>
        </div>
      </section>

      <section className="card section">
        <div className="section-head">
          <div>
            <div className="section-title">General</div>
            <div className="section-desc">Startup, input, and history.</div>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="setting-label">Launch at login</div>
            <div className="setting-help">Keep Ray ready in the tray.</div>
          </div>
          <button
            role="switch"
            aria-checked={snapshot.launch_at_login}
            aria-label="Launch at login"
            className="switch"
            disabled={busy === "autostart"}
            onClick={() =>
              void update(
                { launch_at_login: !snapshot.launch_at_login },
                "autostart",
              )
            }
          />
        </div>

        <div className="setting-row">
          <div>
            <div className="setting-label">Microphone</div>
            <div className="setting-help">
              Applies to the next recording.
            </div>
          </div>
          <div className="select-wrap">
            <select
              value={selectedDevice ?? ""}
              disabled={busy === "mic"}
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
                <option value={selectedDevice}>{selectedDevice}</option>
              )}
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                  {device.is_default ? "  ·  default" : ""}
                </option>
              ))}
            </select>
            <ChevronIcon size={13} />
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="setting-label">Keep original transcripts</div>
            <div className="setting-help">
              Saves the uncleaned transcript alongside each history entry.
            </div>
          </div>
          <button
            role="switch"
            aria-checked={snapshot.settings.keep_raw}
            aria-label="Keep original transcripts"
            className="switch"
            disabled={busy === "raw"}
            onClick={() =>
              void update({ keep_raw: !snapshot.settings.keep_raw }, "raw")
            }
          />
        </div>

        <div className="setting-row">
          <div>
            <div className="setting-label">Dictation shortcut</div>
            <div className="setting-help">
              Press once to record, again to stop. Escape cancels.
            </div>
          </div>
          <span className="hotkey-inline">
            <KeyboardIcon size={13} />
            <kbd className="keycap">{hotkeyLabel()}</kbd>
          </span>
        </div>
      </section>

      <section className="card section">
        <div className="section-head">
          <div>
            <div className="section-title">About</div>
            <div className="section-desc">Ray {snapshot.version}</div>
          </div>
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
            className="btn btn-ghost"
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
          <button className="btn btn-ghost" onClick={() => void api.quit()}>
            Quit Ray
          </button>
        </div>
      </section>
    </>
  );
}
