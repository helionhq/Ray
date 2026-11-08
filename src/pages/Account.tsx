import { useCallback, useEffect, useState } from "react";
import type { Account, Snapshot } from "../lib/bridge";
import { api } from "../lib/bridge";

interface Props {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}

const numberFormat = new Intl.NumberFormat();
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });

function resetLabel(account: Account): string {
  const iso = account.usage.resets_at;
  if (iso) {
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) {
      return `resets ${weekdayFormat.format(date)}`;
    }
  }
  return "resets Monday";
}

function dateLabel(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

function planLabel(account: Account): "Starter" | "Pro" {
  return account.plan === "pro" ? "Pro" : "Starter";
}

function proNote(account: Account): string {
  const renews = dateLabel(account.current_period_end);
  if (account.cancel_at_period_end) {
    return renews ? `Cancels on ${renews}` : "Cancels at the end of this period";
  }
  if (renews) {
    const cadence = account.interval === "annual" ? "year" : "month";
    return `Renews on ${renews} · billed every ${cadence}`;
  }
  if (account.status === "past_due") return "Payment past due";
  if (account.status === "canceled") return "Canceled";
  return "Active";
}

export function AccountPage({ snapshot, refresh, notify }: Props) {
  const [account, setAccount] = useState<Account | null>(snapshot.auth.account);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (reportError: boolean) => {
      try {
        const state = await api.refreshAccount();
        setAccount(state.account);
        setError(null);
      } catch (caught) {
        if (reportError) setError(String(caught));
      }
    },
    [],
  );

  // The page can be opened long after the snapshot's cached account was
  // fetched, so ask for a fresh one on mount. Window-focus refreshes happen in
  // App and arrive through the snapshot / account-changed event.
  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    setAccount(snapshot.auth.account);
  }, [snapshot.auth.account]);

  async function upgrade(interval: "monthly" | "annual") {
    setBusy(interval);
    try {
      await api.openCheckout(interval);
      notify("Complete the upgrade in your browser");
    } catch (caught) {
      notify(String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function manageBilling() {
    setBusy("portal");
    try {
      await api.openBillingPortal();
      notify("Opened the billing portal in your browser");
    } catch (caught) {
      notify(String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function signOut() {
    setBusy("signout");
    try {
      await api.signOut();
      await refresh();
      notify("Signed out");
    } catch (caught) {
      notify(String(caught));
    } finally {
      setBusy(null);
    }
  }

  if (!account) {
    return (
      <>
        <header className="page-head">
          <div>
            <h1>Account</h1>
            <p className="sub">Plan, usage, and billing.</p>
          </div>
        </header>
        <div className="card account-loading">
          <p>{error ?? "Loading your account…"}</p>
          {error && (
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void load(true)}
            >
              Try again
            </button>
          )}
        </div>
      </>
    );
  }

  const plan = planLabel(account);
  const starter = plan === "Starter";
  const limit = account.usage.words_limit;
  const used = account.usage.words_used;
  const percent =
    limit && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Account</h1>
          <p className="sub">Plan, usage, and billing.</p>
        </div>
      </header>

      <div className="group-label">Profile</div>
      <div className="card">
        <div className="account-user">
          <span className="account-avatar" aria-hidden="true">
            {(account.user.email || "?").slice(0, 1).toUpperCase()}
          </span>
          <div className="row-copy">
            <div className="label">
              {account.user.name || account.user.email || "Signed in"}
            </div>
            {account.user.name && account.user.email && (
              <div className="help">{account.user.email}</div>
            )}
          </div>
          <span className={`plan-badge${starter ? "" : " is-pro"}`}>{plan}</span>
        </div>
        <div className="row">
          <div className="row-copy">
            <div className="label">Sign out</div>
            <div className="help">You will need to sign in again to dictate.</div>
          </div>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void signOut()}
          >
            {busy === "signout" ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>

      <div className="group-label">Plan</div>
      <div className="card">
        {starter ? (
          <>
            <div className="row account-usage">
              <div className="row-copy">
                <div className="label">Weekly usage</div>
                <div className="help">
                  {numberFormat.format(used)} of{" "}
                  {limit ? numberFormat.format(limit) : "—"} words this week ·{" "}
                  {resetLabel(account)}
                </div>
                <div
                  className="meter"
                  role="progressbar"
                  aria-label="Weekly words used"
                  aria-valuemin={0}
                  aria-valuemax={limit ?? 0}
                  aria-valuenow={used}
                >
                  <span style={{ width: `${percent}%` }} />
                </div>
              </div>
            </div>
            <div className="row account-upgrade">
              <div className="row-copy">
                <div className="label">Upgrade to Pro</div>
                <div className="help">
                  Unlimited words, same privacy. Cancel anytime.
                </div>
              </div>
              <div className="plan-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy !== null}
                  onClick={() => void upgrade("monthly")}
                >
                  {busy === "monthly" ? "Opening…" : "Upgrade to Pro: $8/mo"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => void upgrade("annual")}
                >
                  {busy === "annual" ? "Opening…" : "$6/mo billed yearly"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="row">
            <div className="row-copy">
              <div className="label">Ray Pro</div>
              <div className="help">{proNote(account)}</div>
            </div>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void manageBilling()}
            >
              {busy === "portal" ? "Opening…" : "Manage billing"}
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}

      <p className="account-footnote">
        Starter includes 1,000 words each week. Pro is unlimited under a
        reasonable fair-use limit. Weeks reset Monday at 00:00 UTC.
      </p>
    </>
  );
}
