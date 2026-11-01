import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryEntry, Snapshot } from "../lib/bridge";
import { api } from "../lib/bridge";
import { diffTranscript } from "../lib/diff";
import {
  dayKey,
  dayLabel,
  duration,
  isoOf,
  timeOf,
  wordCount,
} from "../lib/format";
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
const numberFormat = new Intl.NumberFormat();

function RawTranscript({ raw, cleaned }: { raw: string; cleaned: string }) {
  const pieces = useMemo(() => diffTranscript(raw, cleaned), [raw, cleaned]);
  return (
    <>
      {pieces.map((piece, index) =>
        piece.removed ? (
          <s key={index}>{piece.text}</s>
        ) : (
          <span key={index}>{piece.text}</span>
        ),
      )}
    </>
  );
}

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

  const stats = useMemo(() => {
    const today = dayKey(Date.now());
    let todayCount = 0;
    let words = 0;
    let spokenMs = 0;
    for (const entry of snapshot.history) {
      if (dayKey(entry.created_at) !== today) continue;
      todayCount++;
      words += wordCount(entry.text);
      spokenMs += Math.max(0, entry.duration_ms);
    }
    // ≈ max(0, words at 40 wpm − minutes actually spent speaking).
    const savedMinutes = Math.max(0, words / 40 - spokenMs / 60_000);
    return {
      total: snapshot.history.length,
      todayCount,
      words,
      savedMinutes: Math.round(savedMinutes),
    };
  }, [snapshot.history]);

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

  return (
    <>
      <header className="page-head">
        <div>
          <h1>History</h1>
          <p className="sub">Every dictation, cleaned and saved on this PC.</p>
        </div>
        {stats.total > 0 && (
          <button
            type="button"
            className={`btn btn-ghost${armedClear ? " is-armed" : ""}`}
            onClick={() => void clearAll()}
          >
            {armedClear ? "Confirm clear" : "Clear all"}
          </button>
        )}
      </header>

      <div className="stats">
        <div className="stat">
          <b>{numberFormat.format(stats.total)}</b>
          <span>total dictations</span>
        </div>
        <div className="stat">
          <b>{numberFormat.format(stats.todayCount)}</b>
          <span>today</span>
        </div>
        <div className="stat">
          <b>{numberFormat.format(stats.words)}</b>
          <span>words today</span>
        </div>
        <div className="stat">
          <b>≈ {numberFormat.format(stats.savedMinutes)} min</b>
          <span>typing saved today</span>
        </div>
      </div>

      <div className="search">
        <SearchIcon size={15} />
        <input
          ref={search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search dictations, apps, or words"
          aria-label="Search dictations"
          spellCheck={false}
        />
        {query ? (
          <button
            type="button"
            className="search-clear"
            onClick={() => setQuery("")}
            aria-label="Clear search"
          >
            <XIcon size={12} />
          </button>
        ) : (
          <kbd>Ctrl F</kbd>
        )}
      </div>
      <span className="sr-only" role="status">
        {query
          ? `${filtered.length} ${filtered.length === 1 ? "result" : "results"}`
          : ""}
      </span>

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
                const showRaw = expanded.has(entry.id) && Boolean(entry.raw);
                const showFull = expandedText.has(entry.id);
                const longText = entry.text.length > LONG_ENTRY_CHARS;
                return (
                  <article key={entry.id} className="entry">
                    <time
                      className="entry-time"
                      dateTime={isoOf(entry.created_at)}
                    >
                      {timeOf(entry.created_at)}
                    </time>
                    <div className="entry-body">
                      <p
                        className={`entry-text${
                          longText && !showFull ? " is-clamped" : ""
                        }${showFull ? " is-expanded" : ""}`}
                      >
                        {entry.text}
                      </p>
                      {showRaw && entry.raw && (
                        <div className="entry-raw">
                          <span className="entry-raw-label">
                            Original transcript
                          </span>
                          <p className="entry-raw-text">
                            <RawTranscript raw={entry.raw} cleaned={entry.text} />
                          </p>
                        </div>
                      )}
                      <div className="entry-meta">
                        <span className="app-chip">
                          <i aria-hidden="true" />
                          {entry.app ?? "Unknown"}
                        </span>
                        <span className="meta-sep" />
                        <span className="mono">
                          {duration(entry.duration_ms)}
                        </span>
                        <span className="meta-sep" />
                        <span>{wordCount(entry.text)} words</span>

                        <div className="actions">
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => void copy(entry)}
                          >
                            <CopyIcon size={13} />
                            Copy
                          </button>
                          {longText && (
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => toggleText(entry.id)}
                              aria-expanded={showFull}
                            >
                              {showFull ? "Show less" : "Show more"}
                            </button>
                          )}
                          {entry.raw && (
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => toggleRaw(entry.id)}
                              aria-expanded={showRaw}
                            >
                              {expanded.has(entry.id)
                                ? "Hide original"
                                : "Original"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="icon-btn danger"
                            onClick={() => void remove(entry)}
                            aria-label="Delete entry"
                            title="Delete"
                          >
                            <TrashIcon size={13} />
                          </button>
                        </div>
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
