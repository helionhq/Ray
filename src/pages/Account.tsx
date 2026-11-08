import { useCallback, useEffect, useState } from "react";
import type { Account, Snapshot } from "../lib/bridge";
import { api } from "../lib/bridge";

interface Props {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
  activatingPro: boolean;
}

const numberFormat = new Intl.NumberFormat();
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
// Decision 15: the weekly reset is always shown in UTC, never as a local
// weekday (which can read as the wrong day near midnight).
const resetFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function resetLabel(account: Account): string {
  const iso = account.usage.resets_at;
  if (iso) {
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) {
      return `resets ${resetFormat.format(date)} UTC`;
    }
  }
  return "resets Monday 00:00 UTC";
}

function dateLabel(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

function planLabel(account: Account): "Starter" | "Pro" | "Pro trial" {
  // A trial resolves as Pro but is not a paid subscription; never label it
  // as one.
  if (account.trial !== null) return "Pro trial";
  return account.plan === "pro" ? "Pro" : "Starter";
}

/** Whole days left in the trial, never negative. */
function trialDaysLeft(account: Account): number {
  const endsAt = account.trial?.ends_at;
  if (!endsAt) return 0;
  const ends = new Date(endsAt).getTime();
  if (Number.isNaN(ends)) return 0;
  return Math.max(0, Math.ceil((ends - Date.now()) / 86_400_000));
}

function proNote(account: Account): string {
  const renews = dateLabel(account.current_period_end);
  // A trial is not a renewal, and a canceled subscription that is still
  // within its paid period ends rather than renews.
  if (account.status === "trialing") {
    return renews ? `Trial ends ${renews}` : "Trial active";
  }
  if (account.status === "canceled") {
    return renews ? `Ends on ${renews}` : "Ended";
  }
  if (account.cancel_at_period_end) {
    return renews ? `Cancels on ${renews}` : "Cancels at the end of this period";
  }
  if (renews) {
    const cadence = account.interval === "annual" ? "year" : "month";
    return `Renews on ${renews} · billed every ${cadence}`;
  }
  if (account.status === "past_due") return "Payment past due";
  return "Active";
}

export function AccountPage({
  snapshot,
  refresh,
  notify,
  activatingPro,
}: Props) {
  const [account, setAccount] = useState<Account | null>(snapshot.auth.account);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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

  async function refreshNow() {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
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
  const isTrial = account.trial !== null;
  const trialDays = trialDaysLeft(account);
  const starter = plan === "Starter";
  const showUpgrade = starter || isTrial;
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
        <button
          type="button"
          className="btn"
          disabled={refreshing || busy !== null}
          onClick={() => void refreshNow()}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
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
        {activatingPro && (
          <div className="row" role="status">
            <div className="row-copy">
              <div className="label">Activating Pro…</div>
              <div className="help">
                Confirming your subscription with the billing provider.
              </div>
            </div>
          </div>
        )}
        {account.billing_issue ? (
          <div className="row">
            <div className="row-copy">
              <div className="label">Payment issue: update your card</div>
              <div className="help">
                Ray couldn't charge your payment method. Update it in the
                billing portal to keep dictating.
              </div>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() => void manageBilling()}
            >
              {busy === "portal" ? "Opening…" : "Manage billing"}
            </button>
          </div>
        ) : showUpgrade ? (
          <>
            {isTrial ? (
              <div className="row">
                <div className="row-copy">
                  <div className="label">
                    Pro trial · {trialDays}{" "}
                    {trialDays === 1 ? "day" : "days"} left
                  </div>
                  <div className="help">
                    Everything in Pro while it lasts, no card needed. Upgrade
                    any time to keep Pro when the trial ends.
                  </div>
                </div>
              </div>
            ) : (
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
                    // aria-valuenow must never exceed its max, even when the
                    // server reports usage above the limit.
                    aria-valuenow={Math.min(used, limit ?? used)}
                  >
                    <span style={{ width: `${percent}%` }} />
                  </div>
                </div>
              </div>
            )}
            {account.free_blocked && (
              <div className="row">
                <div className="row-copy">
                  <div className="label">
                    Free limit reached on this account
                  </div>
                  <div className="help">
                    This account can&rsquo;t use the free plan because too many
                    accounts were created on one PC. Upgrade to Pro to keep
                    dictating.
                  </div>
                </div>
              </div>
            )}
            <div className="row account-upgrade">
              <div className="row-copy">
                <div className="label">Upgrade to Pro</div>
                <div className="help">
                  Unlimited words. Fair use applies. Cancel anytime.
                </div>
              </div>
              <div className="plan-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy !== null || activatingPro}
                  onClick={() => void upgrade("monthly")}
                >
                  {busy === "monthly" ? "Opening…" : "Upgrade to Pro: $9/mo"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null || activatingPro}
                  onClick={() => void upgrade("annual")}
                >
                  {busy === "annual" ? "Opening…" : "$7/mo billed yearly"}
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
