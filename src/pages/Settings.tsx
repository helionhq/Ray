import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type {
  CleanupMode,
  Provider,
  Settings,
  Snapshot,
  Theme,
} from "../lib/bridge";
import { api } from "../lib/bridge";
import { applyTheme } from "../lib/theme";
import { hotkeyLabel } from "../lib/format";
import {
  updatesSupported,
  type UpdateCheck,
  type Updater,
} from "../lib/updater";
import {
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  EyeIcon,
  EyeOffIcon,
  MoreIcon,
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
type KeyTest = "connected" | "failed" | null;

const emptyDrafts: Drafts = { assemblyai: "", vercel: "" };
const hidden: Reveals = { assemblyai: false, vercel: false };
const unflagged: ProviderFlags = {
  assemblyai: false,
  vercel: false,
};
const untested: Record<Provider, KeyTest> = { assemblyai: null, vercel: null };

const cleanupModeHelp: Record<CleanupMode, string> = {
  clean: "Fixes fillers and grammar, keeping your wording.",
  structured: "Rewrites for flow, with paragraphs and lists.",
};

export function SettingsPage({ snapshot, refresh, notify, updater }: Props) {
  const [drafts, setDrafts] = useState<Drafts>(emptyDrafts);
  const [reveals, setReveals] = useState<Reveals>(hidden);
  const [replacing, setReplacing] = useState<ProviderFlags>(unflagged);
  const [testStates, setTestStates] = useState<Record<Provider, KeyTest>>(untested);
  const [testErrors, setTestErrors] = useState<Partial<Record<Provider, string>>>({});
  const [menuFor, setMenuFor] = useState<Provider | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    right: number;
  } | null>(null);
  const [armedRemove, setArmedRemove] = useState<Provider | null>(null);
  const [focusAfterRemove, setFocusAfterRemove] = useState<Provider | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checked, setChecked] = useState<UpdateCheck | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const moreRefs = useRef<Partial<Record<Provider, HTMLButtonElement | null>>>({});

  useEffect(() => {
    if (!armedRemove) return;
    const timer = window.setTimeout(() => setArmedRemove(null), 4000);
    return () => window.clearTimeout(timer);
  }, [armedRemove]);

  useEffect(() => {
    const provider = menuFor;
    if (provider === null) return;
    const activeProvider: Provider = provider;
    const menu = menuRef.current;
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();

    function closeOnOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (menu?.contains(target)) return;
      if (moreRefs.current[activeProvider]?.contains(target)) return;
      setMenuFor(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuFor(null);
      moreRefs.current[activeProvider]?.focus();
    }
    function close() {
      setMenuFor(null);
    }

    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuFor]);

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
      setTestStates((current) => ({ ...current, [provider]: null }));
      setTestErrors((current) => ({ ...current, [provider]: undefined }));
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
    setTestErrors((current) => ({ ...current, [provider]: undefined }));
    try {
      if (drafts[provider].trim()) {
        await api.saveSecret(provider, drafts[provider].trim());
        setDrafts((current) => ({ ...current, [provider]: "" }));
        setReveals((current) => ({ ...current, [provider]: false }));
        setReplacing((current) => ({ ...current, [provider]: false }));
      }
      const message = await api.testSecret(provider);
      setTestStates((current) => ({ ...current, [provider]: "connected" }));
      notify(message);
      await refresh();
    } catch (error) {
      setTestStates((current) => ({ ...current, [provider]: "failed" }));
      setTestErrors((current) => ({ ...current, [provider]: String(error) }));
      notify(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function removeKey(provider: Provider) {
    setBusy(`remove-${provider}`);
    try {
      await api.clearSecret(provider);
      setMenuFor(null);
      setArmedRemove(null);
      setTestStates((current) => ({ ...current, [provider]: null }));
      setTestErrors((current) => ({ ...current, [provider]: undefined }));
      setReplacing((current) => ({ ...current, [provider]: false }));
      setDrafts((current) => ({ ...current, [provider]: "" }));
      setReveals((current) => ({ ...current, [provider]: false }));
      setFocusAfterRemove(provider);
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

  function toggleKeyMenu(provider: Provider, trigger: HTMLButtonElement) {
    if (menuFor === provider) {
      setMenuFor(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    setMenuPosition({
      top: rect.bottom + 6,
      right: Math.max(12, window.innerWidth - rect.right),
    });
    setArmedRemove(null);
    setMenuFor(provider);
  }

  function beginReplace(provider: Provider) {
    setReplacing((current) => ({ ...current, [provider]: true }));
    setMenuFor(null);
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    );
    if (event.key === "Tab") {
      setMenuFor(null);
      return;
    }
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = (index + 1) % items.length;
        break;
      case "ArrowUp":
        next = (index - 1 + items.length) % items.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
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
    const isTesting = busy === `test-${provider}`;
    const editing = !isSaved || isReplacing;
    const testState = testStates[provider];
    const menuOpen = menuFor === provider;
    const menuId = `key-menu-${provider}`;

    let status: ReactNode;
    if (isTesting) {
      status = (
        <span className="key-status" aria-live="polite">
          <span className="status-spinner" aria-hidden="true" />
          Testing…
        </span>
      );
    } else if (testState === "connected") {
      status = (
        <span className="key-status is-ok" aria-live="polite">
          <CheckIcon size={13} />
          Connected
        </span>
      );
    } else if (testState === "failed") {
      status = (
        <span
          className="key-status is-error"
          aria-live="polite"
          title={testErrors[provider]}
        >
          <AlertIcon size={13} />
          Test failed
        </span>
      );
    } else if (isSaved) {
      status = (
        <span className="key-status">
          <span className="status-dot" aria-hidden="true" />
          Saved
        </span>
      );
    } else {
      status = (
        <span className="key-status is-muted">
          <span className="status-dot is-empty" aria-hidden="true" />
          Not set
        </span>
      );
    }

    return (
      <Fragment key={provider}>
        <div className="row">
          <div className="row-copy">
            <div className="label">{label}</div>
            <div className="help">{help}</div>
          </div>
          <div className="key">
            {status}
            <button
              type="button"
              className="btn btn-ghost"
              aria-label={`Test ${label} key`}
              onClick={() => void testKey(provider)}
              disabled={isBusy || (!isSaved && !drafts[provider].trim())}
            >
              Test
            </button>
            {isSaved && !isReplacing && (
              <button
                ref={(node) => {
                  moreRefs.current[provider] = node;
                }}
                type="button"
                className="key-more"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls={menuOpen ? menuId : undefined}
                aria-label={`More actions for ${label}`}
                title={`More actions for ${label}`}
                onClick={(event) => toggleKeyMenu(provider, event.currentTarget)}
              >
                <MoreIcon size={16} />
              </button>
            )}
            {menuOpen && menuPosition && (
              <div
                id={menuId}
                ref={menuRef}
                className="key-menu"
                role="menu"
                aria-label={`${label} key actions`}
                style={{ top: menuPosition.top, right: menuPosition.right }}
                onKeyDown={onMenuKeyDown}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => beginReplace(provider)}
                >
                  Replace key
                </button>
                <div className="menu-sep" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className={`is-danger${
                    armedRemove === provider ? " is-armed" : ""
                  }`}
                  onClick={() => {
                    if (armedRemove === provider) {
                      void removeKey(provider);
                    } else {
                      setArmedRemove(provider);
                    }
                  }}
                >
                  {armedRemove === provider ? "Confirm remove" : "Remove key"}
                </button>
              </div>
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
                autoFocus={isReplacing || focusAfterRemove === provider}
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
              aria-label={`Save ${label} key`}
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
            <div className="help">Turns raw speech into ready-to-send text.</div>
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
        <div className="row">
          <div className="row-copy">
            <div className="label">Mode</div>
            <div className="help">
              Clean fixes fillers and grammar. Structured rewrites for flow.
            </div>
          </div>
          <div className="segmented" role="group" aria-label="Cleanup mode">
            {(["clean", "structured"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={snapshot.settings.cleanup_mode === mode}
                disabled={busy !== null || !snapshot.settings.cleanup_enabled}
                title={cleanupModeHelp[mode]}
                onClick={() => void update({ cleanup_mode: mode }, "mode")}
              >
                {mode === "clean" ? "Clean" : "Structured"}
              </button>
            ))}
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
        <div className="about-actions">
          <button
            type="button"
            className="btn btn-ghost"
            title="Reload pipeline.json, cleanup.md and structured.md overrides"
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
