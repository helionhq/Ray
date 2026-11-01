import { UpdateIcon } from "./Icons";
import type { UpdaterState } from "../lib/updater";

interface UpdateCardProps {
  state: UpdaterState;
  onInstall: () => void;
}

export function UpdateCard({ state, onInstall }: UpdateCardProps) {
  if (!state.version) return null;

  const busy = state.phase !== "idle";
  const percent =
    state.progress === null ? null : Math.round(state.progress * 100);
  const title = state.error
    ? "Update failed"
    : state.phase === "installing"
      ? "Installing update"
      : state.phase === "downloading"
        ? "Downloading update"
        : "Update available";
  const label = state.error
    ? "Retry"
    : state.phase === "installing"
      ? "Installing…"
      : state.phase === "downloading"
        ? percent === null
          ? "Downloading…"
          : `${percent}%`
        : "Update";
  const action = state.error
    ? "Retry update"
    : state.phase === "installing"
      ? "Installing update"
      : state.phase === "downloading"
        ? "Downloading update"
        : `Update Ray to version ${state.version}`;

  return (
    <div className="sidebar-foot">
      <div className={`update-card${state.error ? " has-error" : ""}`}>
        <div className="update-card-copy" aria-live="polite">
          <span className="update-card-title">{title}</span>
          <span className="update-card-version mono">v{state.version}</span>
        </div>

        {state.phase === "downloading" && percent !== null && (
          <div
            className="update-progress"
            role="progressbar"
            aria-label="Download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary update-card-btn"
          onClick={onInstall}
          disabled={busy}
          aria-label={action}
          title={state.error ?? action}
        >
          <UpdateIcon size={13} />
          <span className="update-card-btn-label">{label}</span>
        </button>
      </div>
    </div>
  );
}
