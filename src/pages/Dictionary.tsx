import { useRef, useState, type FormEvent } from "react";
import type { Snapshot } from "../lib/bridge";
import { api } from "../lib/bridge";
import { PlusIcon, XIcon } from "../components/Icons";

interface Props {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}

export function DictionaryPage({ snapshot, refresh, notify }: Props) {
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const words = snapshot.dictionary;

  async function add(event: FormEvent) {
    event.preventDefault();
    const value = term.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await api.addDictionary(value);
      setTerm("");
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
        <span className="count">{words.length}</span>
      </header>

      <form className="dictionary-add" onSubmit={(event) => void add(event)}>
        <input
          ref={input}
          className="input"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Add a word or name, e.g. Helion HQ"
          aria-label="Add a dictionary term"
          spellCheck={false}
          autoComplete="off"
          maxLength={80}
        />
        <button className="btn btn-primary" type="submit" disabled={!term.trim() || busy}>
          <PlusIcon size={13} />
          Add
        </button>
      </form>

      {words.length === 0 ? (
        <div className="empty empty-compact">
          <p>No custom words yet.</p>
          <span>
            Add the names you say most. They go to the transcriber as keyterms
            and to the cleanup model as the preferred spelling.
          </span>
        </div>
      ) : (
        <ul className="word-list">
          {words.map((word) => (
            <li key={word} className="word-row">
              <span>{word}</span>
              <button
                className="icon-button"
                onClick={() => void remove(word)}
                aria-label={`Remove ${word}`}
                title="Remove"
              >
                <XIcon size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="note-block">
        <p className="note-title">How Ray uses these</p>
        <p>
          Every term is sent to AssemblyAI as a keyterm and inserted into the
          cleanup prompt, so names keep their exact spelling and capitalization.
          Changes apply to the next dictation.
        </p>
      </div>
    </>
  );
}
