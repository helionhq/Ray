import { useCallback, useEffect, useState } from "react";
import { api, onEvent, type Snapshot } from "./lib/bridge";
import { hotkeyLabel } from "./lib/format";
import { DictionaryPage } from "./pages/Dictionary";
import { HistoryPage } from "./pages/History";
import { SettingsPage } from "./pages/Settings";
import { Toast, type Notice } from "./components/Toast";
import {
  DictionaryIcon,
  HistoryIcon,
  KeyboardIcon,
  RayMark,
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

  const notify = useCallback((text: string) => {
    setNotice({ id: Date.now(), text });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.snapshot();
      setSnapshot(next);
      setError(null);
    } catch (caught) {
      setError(String(caught));
    }
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

  if (error) {
    return (
      <div className="boot">
        <RayMark size={22} />
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
        <RayMark size={22} />
        <span className="boot-wait">Loading Ray…</span>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">
            <RayMark size={19} />
          </span>
          <span>Ray</span>
        </div>

        <nav aria-label="Sections">
          {pages.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item${page === id ? " is-active" : ""}`}
              onClick={() => setPage(id)}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={15} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="hotkey-row">
            <KeyboardIcon size={13} />
            <kbd className="keycap">{hotkeyLabel()}</kbd>
            <span>to dictate</span>
          </div>
          {!snapshot.keys.assemblyai && (
            <button className="sidebar-note" onClick={() => setPage("settings")}>
              Add an AssemblyAI key to start.
            </button>
          )}
        </div>
      </aside>

      <main className="content">
        <div className="page">
          {page === "history" && (
            <HistoryPage
              snapshot={snapshot}
              refresh={refresh}
              notify={notify}
            />
          )}
          {page === "dictionary" && (
            <DictionaryPage
              snapshot={snapshot}
              refresh={refresh}
              notify={notify}
            />
          )}
          {page === "settings" && (
            <SettingsPage
              snapshot={snapshot}
              refresh={refresh}
              notify={notify}
            />
          )}
        </div>
      </main>

      <Toast notice={notice} />
    </div>
  );
}
