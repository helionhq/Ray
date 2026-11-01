import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { api, onEvent, type Snapshot } from "./lib/bridge";
import { applyTheme } from "./lib/theme";
import { DictionaryPage } from "./pages/Dictionary";
import { HistoryPage } from "./pages/History";
import { SettingsPage } from "./pages/Settings";
import { Toast, type Notice } from "./components/Toast";
import { UpdateCard } from "./components/UpdateCard";
import { useUpdater } from "./lib/updater";
import { RayLogo } from "./components/RayLogo";
import { TitleBar, startDrag, toggleOnDoubleClick } from "./components/TitleBar";
import {
  AlertIcon,
  DictionaryIcon,
  HistoryIcon,
  SettingsIcon,
} from "./components/Icons";

type Page = "history" | "dictionary" | "settings";

const pages: { id: Page; label: string; icon: typeof HistoryIcon }[] = [
  { id: "history", label: "History", icon: HistoryIcon },
  { id: "dictionary", label: "Dictionary", icon: DictionaryIcon },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page>("history");
  const [notice, setNotice] = useState<Notice | null>(null);
  const updater = useUpdater();

  const notify = useCallback((text: string) => {
    setNotice({ id: Date.now(), text });
  }, []);

  const refresh = useCallback(async () => {
    // On a cold start the webview can mount a beat before Tauri's setup has
    // registered the app state. Retry briefly instead of showing a hard
    // "could not load" screen.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const next = await api.snapshot();
        setSnapshot(next);
        setError(null);
        return;
      } catch (caught) {
        lastError = caught;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
    setError(String(lastError));
  }, []);

  useEffect(() => {
    void refresh();
    const unlisteners: Promise<() => void>[] = [
      onEvent("state-changed", () => void refresh()),
      onEvent<string>("notice", (message) => notify(message)),
      onEvent<string>("navigate", (target) => {
        if (target === "settings" || target === "history" || target === "dictionary") {
          setPage(target);
        }
      }),
    ];
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      for (const unlisten of unlisteners) void unlisten.then((fn) => fn());
    };
  }, [refresh, notify]);

  // Apply the store's theme before the snapshot paints, so a chosen theme
  // never flickers on a state refresh.
  const theme = snapshot?.settings.theme;
  useLayoutEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  if (error) {
    return (
      <div className="boot">
        <RayLogo />
        <p>Ray could not load its local state.</p>
        <span>{error}</span>
        <button className="btn" onClick={() => void refresh()}>
          Try again
        </button>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="boot">
        <RayLogo />
        <span className="boot-wait">Loading Ray…</span>
      </div>
    );
  }

  const missingKey = !snapshot.keys.assemblyai;
  const hotkeyIssue = Boolean(snapshot.hotkey_error);
  const showBanner = missingKey || hotkeyIssue;

  return (
    <div className="app">
      <TitleBar />
      <aside className="sidebar">
        <div
          className="brand"
          onMouseDown={startDrag}
          onDoubleClick={toggleOnDoubleClick}
        >
          <RayLogo />
        </div>

        <nav aria-label="Sections">
          {pages.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`nav-item${page === id ? " is-active" : ""}`}
              onClick={() => setPage(id)}
              aria-label={label}
              title={label}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={15} />
              <span>{label}</span>
              {id === "dictionary" && (
                <span className="count mono">{snapshot.dictionary.length}</span>
              )}
            </button>
          ))}
        </nav>

        <UpdateCard state={updater} onInstall={() => void updater.install()} />
      </aside>

      <main className="content">
        {showBanner && (
          <div className="banner" role="status">
            <AlertIcon size={14} className="banner-icon" />
            <span className="banner-text">
              {missingKey && "Add an AssemblyAI key to start dictating."}
              {missingKey && hotkeyIssue && <span className="banner-sep" />}
              {hotkeyIssue && "The Right Alt shortcut is unavailable."}
            </span>
            <button
              type="button"
              className="banner-action"
              onClick={() => setPage("settings")}
            >
              Settings
            </button>
          </div>
        )}

        <div className="page">
          {page === "history" && (
            <HistoryPage snapshot={snapshot} refresh={refresh} notify={notify} />
          )}
          {page === "dictionary" && (
            <DictionaryPage snapshot={snapshot} refresh={refresh} notify={notify} />
          )}
          {page === "settings" && (
            <SettingsPage
              snapshot={snapshot}
              refresh={refresh}
              notify={notify}
              updater={updater}
            />
          )}
        </div>
      </main>

      <Toast notice={notice} />
    </div>
  );
}
