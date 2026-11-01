import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Snapshot } from "../lib/bridge";
import { api } from "../lib/bridge";
import { ReturnIcon, XIcon } from "../components/Icons";

interface Props {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}

export function DictionaryPage({ snapshot, refresh, notify }: Props) {
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const words = snapshot.dictionary;

  useEffect(() => {
    if (!justAdded) return;
    const timer = window.setTimeout(() => setJustAdded(null), 2400);
    return () => window.clearTimeout(timer);
  }, [justAdded]);

  async function add(event: FormEvent) {
    event.preventDefault();
    const value = term.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await api.addDictionary(value);
      setTerm("");
      setJustAdded(value);
      await refresh();
      input.current?.focus();
    } catch (error) {
      notify(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(word: string) {
    try {
      await api.removeDictionary(word);
      await refresh();
    } catch (error) {
      notify(String(error));
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Dictionary</h1>
          <p className="sub">
            Names, products, and jargon Ray should always spell your way.
          </p>
        </div>
      </header>

      <form className="dictionary-add" onSubmit={(event) => void add(event)}>
        <input
          ref={input}
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Add a name, product, or term — e.g. Helion HQ"
          aria-label="Add a dictionary term"
          spellCheck={false}
          autoComplete="off"
          maxLength={80}
        />
        <button
          type="submit"
          className="btn-primary"
          disabled={!term.trim() || busy}
        >
          Add
          <kbd>
            <ReturnIcon size={11} />
          </kbd>
        </button>
      </form>

      <div className="list-head">
        {words.length} {words.length === 1 ? "term" : "terms"}
      </div>

      {words.length === 0 ? (
        <div className="empty empty-compact">
          <p>No custom words yet.</p>
          <span>Add the names you say most.</span>
        </div>
      ) : (
        <div className="chips">
          {words.map((word) => (
            <span
              key={word}
              className={`chip${justAdded === word ? " is-new" : ""}`}
            >
              <span className="chip-label">{word}</span>
              <button
                type="button"
                className="x"
                onClick={() => void remove(word)}
                aria-label={`Remove ${word}`}
                title="Remove"
              >
                <XIcon size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
