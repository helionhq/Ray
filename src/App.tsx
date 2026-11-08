import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api, onEvent, type Snapshot } from "./lib/bridge";
import { applyTheme } from "./lib/theme";
import { AccountPage } from "./pages/Account";
import { DictionaryPage } from "./pages/Dictionary";
import { HistoryPage } from "./pages/History";
import { SignInScreen } from "./pages/SignIn";
import { SettingsPage } from "./pages/Settings";
import { Toast, type Notice } from "./components/Toast";
import { UpdateCard } from "./components/UpdateCard";
import { useUpdater } from "./lib/updater";
import { RayLogo } from "./components/RayLogo";
import { TitleBar, startDrag, toggleOnDoubleClick } from "./components/TitleBar";
import {
  AccountIcon,
  AlertIcon,
  DictionaryIcon,
  HistoryIcon,
  SettingsIcon,
} from "./components/Icons";

type Page = "history" | "dictionary" | "account" | "settings";

const pages: { id: Page; label: string; icon: typeof HistoryIcon }[] = [
  { id: "history", label: "History", icon: HistoryIcon },
  { id: "dictionary", label: "Dictionary", icon: DictionaryIcon },
  { id: "account", label: "Account", icon: AccountIcon },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page>("history");
  const [notice, setNotice] = useState<Notice | null>(null);
  const updater = useUpdater();
  const refreshedAccount = useRef(false);

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
        if (
          target === "settings" ||
          target === "history" ||
          target === "dictionary" ||
          target === "account"
        ) {
          setPage(target);
        }
      }),
      // Sign-in, sign-out, billing, and pipeline quota refreshes all land here.
      onEvent("account-changed", () => void refresh()),
    ];
    // Refresh the account on window focus, as the contract expects, so a
    // browsing round-trip (or a checkout in another window) is reflected as
    // soon as the user comes back.
    const onFocus = () => {
      void (async () => {
        try {
          await api.refreshAccount();
        } catch {
          // Signed out, offline, or a transient server error: the cached
          // snapshot stays on screen until the next refresh succeeds.
        }
        await refresh();
      })();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      for (const unlisten of unlisteners) void unlisten.then((fn) => fn());
    };
  }, [refresh, notify]);

  // The snapshot carries the cached account; fetch it once on a signed-in
  // start so the Account page and quota gate have data immediately.
  useEffect(() => {
    if (!snapshot?.auth.signed_in || snapshot.auth.account || refreshedAccount.current) {
      return;
    }
    refreshedAccount.current = true;
    void api.refreshAccount().catch(() => {});
  }, [snapshot?.auth.signed_in, snapshot?.auth.account]);

  // Apply the store's theme before the snapshot paints, so a chosen theme
  // never flickers on a state refresh.
  const theme = snapshot?.settings.theme;
  useLayoutEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  if (error) {
    return (
      // The boot screens keep the caption mounted too: the window has no
      // native decorations, so without it a failed start cannot be moved,
      // minimised, or closed.
      <div className="boot-screen">
        <TitleBar />
        <div
          className="boot"
          onMouseDown={startDrag}
          onDoubleClick={toggleOnDoubleClick}
        >
          <RayLogo />
          <p>Ray could not load its local state.</p>
          <span>{error}</span>
          <button className="btn" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="boot-screen">
        <TitleBar />
        <div
          className="boot"
          onMouseDown={startDrag}
          onDoubleClick={toggleOnDoubleClick}
        >
          <RayLogo />
          <span className="boot-wait">Loading Ray…</span>
        </div>
      </div>
    );
  }

  if (!snapshot.auth.signed_in) {
    return <SignInScreen />;
  }

  const hotkeyIssue = Boolean(snapshot.hotkey_error);

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
        {hotkeyIssue && (
          <div className="banner" role="status">
            <AlertIcon size={14} className="banner-icon" />
            <span className="banner-text">
              Your dictation shortcut is unavailable.
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
          {page === "account" && (
            <AccountPage snapshot={snapshot} refresh={refresh} notify={notify} />
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
