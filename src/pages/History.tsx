import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryEntry, Snapshot } from "../lib/bridge";
import { api } from "../lib/bridge";
import { dayKey, dayLabel, duration, isoOf, timeOf } from "../lib/format";
import {
  CopyIcon,
  MicIcon,
  SearchIcon,
  TrashIcon,
  XIcon,
} from "../components/Icons";

interface Props {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}

/** Above this, the six-line clamp is likely hiding part of the cleaned text. */
const LONG_ENTRY_CHARS = 420;

export function HistoryPage({ snapshot, refresh, notify }: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedText, setExpandedText] = useState<Set<string>>(new Set());
  const [armedClear, setArmedClear] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        search.current?.focus();
      }
      if (event.key === "Escape" && document.activeElement === search.current) {
        setQuery("");
        search.current?.blur();
      }
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, []);

  useEffect(() => {
    if (!armedClear) return;
    const timer = window.setTimeout(() => setArmedClear(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armedClear]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return snapshot.history;
    return snapshot.history.filter((entry) => {
      const haystack = `${entry.text} ${entry.raw ?? ""} ${entry.app ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [snapshot.history, query]);

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: HistoryEntry[] }[] = [];
    for (const entry of filtered) {
      const key = dayKey(entry.created_at);
      const last = out[out.length - 1];
      if (last && last.key === key) {
        last.items.push(entry);
      } else {
        out.push({
          key,
          label: dayLabel(entry.created_at),
          items: [entry],
        });
      }
    }
    return out;
  }, [filtered]);

  function toggleRaw(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleText(id: string) {
    setExpandedText((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copy(entry: HistoryEntry) {
    try {
      await api.copyText(entry.text);
      notify("Copied to clipboard");
    } catch (error) {
      notify(String(error));
    }
  }

  async function remove(entry: HistoryEntry) {
    try {
      await api.deleteHistory(entry.id);
      notify("Entry deleted");
      await refresh();
    } catch (error) {
      notify(String(error));
    }
  }

  async function clearAll() {
    if (!armedClear) {
      setArmedClear(true);
      return;
    }
    setArmedClear(false);
    try {
      await api.clearHistory();
      notify("History cleared");
      await refresh();
    } catch (error) {
      notify(String(error));
    }
  }

  const total = snapshot.history.length;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>History</h1>
          <p className="sub">
            {total === 0
              ? "Every dictation lands here, cleaned and ready to reuse."
              : `${total} ${total === 1 ? "dictation" : "dictations"} saved locally on this PC.`}
          </p>
        </div>
        {total > 0 && (
          <button
            className={`btn btn-ghost${armedClear ? " is-armed" : ""}`}
            onClick={() => void clearAll()}
          >
            {armedClear ? "Confirm clear" : "Clear all"}
          </button>
        )}
      </header>

      <div className="toolbar">
        <div className="search">
          <SearchIcon size={14} />
          <input
            ref={search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search dictations"
            aria-label="Search dictations"
            spellCheck={false}
          />
          {query && (
            <button
              className="search-clear"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <XIcon size={12} />
            </button>
          )}
        </div>
        <span className="toolbar-count">
          {query
            ? `${filtered.length} ${filtered.length === 1 ? "result" : "results"}`
            : ""}
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="empty">
          <span className="empty-icon">
            <MicIcon size={18} />
          </span>
          <p>{query ? "Nothing matches that search." : "No dictations yet."}</p>
          <span>
            {query
              ? "Try a different word or the app name."
              : "Press Right Alt, say what you mean, then press it again."}
          </span>
        </div>
      ) : (
        <div className="entries">
          {groups.map((group) => (
            <section key={group.key} className="day-group">
              <h2 className="day-label">{group.label}</h2>
              {group.items.map((entry) => {
                const showRaw = expanded.has(entry.id) && entry.raw;
                const showFull = expandedText.has(entry.id);
                const longText = entry.text.length > LONG_ENTRY_CHARS;
                return (
                  <article key={entry.id} className="entry">
                    <div className="entry-rail">
                      <time className="entry-time" dateTime={isoOf(entry.created_at)}>
                        {timeOf(entry.created_at)}
                      </time>
                      <span className="entry-app">{entry.app ?? "Unknown"}</span>
                      <span className="entry-duration">{duration(entry.duration_ms)}</span>
                    </div>
                    <div className="entry-body">
                      <p className={`entry-text${showFull ? " is-expanded" : ""}`}>
                        {entry.text}
                      </p>
                      {showRaw && (
                        <div className="entry-raw">
                          <span className="entry-raw-label">Original transcript</span>
                          <p>{entry.raw}</p>
                        </div>
                      )}
                      <div className="entry-actions">
                        <button onClick={() => void copy(entry)}>
                          <CopyIcon size={13} />
                          Copy
                        </button>
                        {longText && (
                          <button
                            onClick={() => toggleText(entry.id)}
                            aria-expanded={showFull}
                          >
                            {showFull ? "Show less" : "Show more"}
                          </button>
                        )}
                        {entry.raw && (
                          <button onClick={() => toggleRaw(entry.id)}>
                            {expanded.has(entry.id) ? "Hide original" : "Original"}
                          </button>
                        )}
                        <button
                          className="entry-delete"
                          onClick={() => void remove(entry)}
                        >
                          <TrashIcon size={13} />
                          Delete
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
