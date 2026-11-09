import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useAuth } from "@clerk/react";
import {
  ApiError,
  createCheckout,
  createPortalSession,
  fetchMe,
  isSafeHttpUrl,
  revokeAllDevices,
  type MeResponse,
} from "../lib/api";
import { clerkEnabled } from "../lib/clerk";
import {
  formatDate,
  formatNumber,
  formatResetAt,
  initialsOf,
} from "../lib/format";
import { usePageMeta } from "../lib/head";
import { Link, useLocation, useNavigate } from "../lib/router";
import {
  DOWNLOAD_URL,
  PLANS,
  RESET_LABEL,
  proPrice,
  type BillingInterval,
} from "../content";
import {
  clearBillingActivation,
  readBillingActivation,
} from "../lib/billing-success";
import {
  AlertIcon,
  ArrowRightIcon,
  CreditCardIcon,
  DownloadIcon,
  LogOutIcon,
} from "../components/Icons";
import { AuthNotConfigured } from "../components/AuthNotConfigured";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";

type AccountBusy = BillingInterval | "portal" | "devices";

/**
 * 1 s, 2 s, 4 s, … ~45 s total. The desktop uses the same schedule while it
 * waits for the Creem webhook to grant Pro.
 */
const ACTIVATION_POLL_DELAYS = [1000, 2000, 4000, 8000, 16000, 14000];

const BILLING_ISSUE_DETAIL: Record<
  NonNullable<MeResponse["billing_issue"]>,
  string
> = {
  past_due:
    "Your last payment didn't go through, so Pro is paused until your card is updated.",
  unpaid:
    "Your subscription is unpaid, so Pro is paused until your balance is settled.",
  paused:
    "Your subscription is paused. Update your billing details to resume Pro.",
};

function isBillingInterval(value: string | null): value is BillingInterval {
  return value === "monthly" || value === "annual";
}

function errorMessage(caught: unknown, fallback: string) {
  return caught instanceof ApiError ? caught.message : fallback;
}

/** Whole days left in the trial, never negative (0 on the last partial day). */
function trialDaysLeft(endsAt: string | null | undefined): number {
  if (!endsAt) return 0;
  const ends = Date.parse(endsAt);
  if (!Number.isFinite(ends)) return 0;
  return Math.max(0, Math.ceil((ends - Date.now()) / 86_400_000));
}

function AccountFrame({
  children,
  loading = false,
}: {
  children: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="site">
      <SiteHeader />
      <main
        id="main"
        className="page-main"
        tabIndex={-1}
        aria-busy={loading || undefined}
      >
        <div className="container account-page">{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}

function AccountSkeleton() {
  return (
    <>
      <div className="account-head">
        <div className="skeleton-stack">
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-sub" />
        </div>
      </div>
      <section className="account-card">
        <div className="skeleton-stack">
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line short" />
        </div>
      </section>
      <section className="account-card">
        <div className="skeleton-stack">
          <span className="skeleton skeleton-line wide" />
          <span className="skeleton skeleton-meter" />
          <span className="skeleton skeleton-line short" />
        </div>
      </section>
      <span className="sr-only" role="status">
        Loading your account…
      </span>
    </>
  );
}

interface AccountActions {
  busy: AccountBusy | null;
  actionError: string | null;
  activating: boolean;
  activationTimedOut: boolean;
  preferredInterval: BillingInterval | null;
  deviceError: string | null;
  deviceMessage: string | null;
  onCheckout: (interval: BillingInterval) => void;
  onPortal: () => void;
  onSignOut: () => void;
  onRevokeDevices: () => void;
}

/**
 * Monthly/annual checkout buttons, shared by the Starter and trial upgrade
 * cards so a trial keeps the upgrade CTAs visible.
 */
function UpgradeOptions({
  actions,
  busy,
  blocked,
}: {
  actions: AccountActions;
  busy: AccountBusy | null;
  blocked: boolean;
}) {
  const monthly = PLANS.pro.monthly;
  const annual = PLANS.pro.annual;

  return (
    <>
      <div className="upgrade-options">
        <button
          type="button"
          className={`upgrade-option${
            actions.preferredInterval === "monthly" ? " is-selected" : ""
          }`}
          onClick={() => actions.onCheckout("monthly")}
          disabled={busy !== null || blocked}
          aria-busy={busy === "monthly" || undefined}
        >
          <span className="upgrade-head">
            <span>Monthly</span>
          </span>
          <span className="upgrade-price">
            ${monthly.price}
            <span className="upgrade-period">/month</span>
          </span>
          <span className="upgrade-billing">{monthly.billing}</span>
          <span className="upgrade-cta">
            {busy === "monthly" ? "Opening checkout…" : "Choose monthly"}
            <ArrowRightIcon size={13} />
          </span>
        </button>

        <button
          type="button"
          className={`upgrade-option${
            actions.preferredInterval === "annual" ? " is-selected" : ""
          }`}
          onClick={() => actions.onCheckout("annual")}
          disabled={busy !== null || blocked}
          aria-busy={busy === "annual" || undefined}
        >
          <span className="upgrade-head">
            <span>Annual</span>
            <span className="save-pill">{annual.savings}</span>
          </span>
          <span className="upgrade-price">
            ${annual.price}
            <span className="upgrade-period">/month</span>
          </span>
          <span className="upgrade-billing">{annual.billing}</span>
          <span className="upgrade-cta">
            {busy === "annual" ? "Opening checkout…" : "Choose annual"}
            <ArrowRightIcon size={13} />
          </span>
        </button>
      </div>

      {actions.actionError ? (
        <p className="form-error" role="alert">
          {actions.actionError}
        </p>
      ) : null}

      <p className="account-hint">
        Cancel anytime. Payments are handled by Creem, our merchant of record.
        Pro is unlimited for normal dictation; fair use applies.
      </p>
    </>
  );
}

function AccountView({
  me,
  actions,
}: {
  me: MeResponse;
  actions: AccountActions;
}) {
  const [confirmingDevices, setConfirmingDevices] = useState(false);
  const isPro = me.plan === "pro";
  // A trial resolves as Pro but is not a paid subscription: keep the badge
  // and copy from claiming one.
  const trial = me.trial;
  const isTrial = trial !== null;
  const isPaidPro = isPro && !isTrial;
  const trialDays = trialDaysLeft(trial?.ends_at);
  const billingIssue = me.billing_issue;
  const limit = me.usage.words_limit ?? PLANS.starter.weeklyWords;
  const used = me.usage.words_used;
  const fill = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
  const atLimit = !isPro && used >= limit;
  const price = me.interval ? proPrice(me.interval) : null;
  const periodEnd = formatDate(me.current_period_end);
  const ending =
    me.cancel_at_period_end ||
    me.status === "canceled" ||
    me.status === "scheduled_cancel";
  const periodLabel = ending
    ? "Cancels"
    : me.status === "trialing"
      ? "Trial ends"
      : "Renews";
  const resetsAt = formatResetAt(me.usage.resets_at);
  const { busy, actionError } = actions;
  // A checkout is in flight until the webhook flips the plan (or the poll
  // times out). Starting another one can create a second subscription and
  // charge, so the CTAs stay disabled; the server enforces the same rule.
  const upgradeBlocked = actions.activating || actions.activationTimedOut;

  return (
    <AccountFrame>
      <header className="account-head">
        <div>
          <h1>Account</h1>
          <p>Manage your plan, usage, and devices.</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={actions.onSignOut}
        >
          <LogOutIcon size={15} />
          Sign out
        </button>
      </header>

      {actions.activating ? (
        <div className="account-card account-activating" role="status">
          <span className="spinner" aria-hidden="true" />
          <div>
            <p className="account-activating-title">Activating Pro…</p>
            <p className="account-muted">
              Payment received. This usually takes a few seconds.
            </p>
          </div>
        </div>
      ) : null}

      {actions.activationTimedOut ? (
        <p className="account-hint account-activation-timeout" role="status">
          Activation is taking longer than usual. Your plan will update as soon
          as the payment provider confirms it — refresh in a minute.
        </p>
      ) : null}

      <section className="account-card account-profile" aria-label="Profile">
        <span className="account-avatar" aria-hidden="true">
          {initialsOf(me.user.name, me.user.email)}
        </span>
        <div className="account-identity">
          <p className="account-name">{me.user.name || "Ray account"}</p>
          <p className="account-email">{me.user.email || "No email on file"}</p>
        </div>
        <span className={`plan-badge${isPro ? " is-pro" : ""}`}>
          {isTrial ? "Pro trial" : isPro ? PLANS.pro.name : PLANS.starter.name}
        </span>
      </section>

      {isPaidPro ? (
        <section className="account-card" aria-labelledby="plan-heading">
          <div className="account-card-head">
            <div>
              <h2 id="plan-heading">Pro plan</h2>
              <p className="account-muted">
                {price
                  ? `$${price.price}/month · ${price.billing.toLowerCase()}`
                  : "Pro subscription"}
              </p>
            </div>
            <span className="plan-badge is-pro">{PLANS.pro.name}</span>
          </div>

          <dl className="account-details">
            <div>
              <dt>{periodLabel}</dt>
              <dd>{periodEnd ?? "—"}</dd>
            </div>
            <div>
              <dt>This week</dt>
              <dd>{formatNumber(used)} words · unlimited</dd>
            </div>
          </dl>

          {billingIssue ? (
            <p className="account-alert" role="status">
              Payment issue: update your card. {BILLING_ISSUE_DETAIL[billingIssue]}
            </p>
          ) : (
            <p className="account-hint">
              Pro is unlimited for normal dictation; fair use applies.
            </p>
          )}

          {actionError ? (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          ) : null}

          <button
            type="button"
            className="btn btn-secondary account-action"
            onClick={actions.onPortal}
            disabled={busy !== null}
            aria-busy={busy === "portal" || undefined}
          >
            <CreditCardIcon size={15} />
            {busy === "portal" ? "Opening…" : "Manage billing"}
          </button>
        </section>
      ) : (
        <>
          {isTrial ? (
            <section className="account-card" aria-labelledby="trial-heading">
              <div className="account-card-head">
                <div>
                  <h2 id="trial-heading">
                    Pro trial · {trialDays} {trialDays === 1 ? "day" : "days"}{" "}
                    left
                  </h2>
                  <p className="account-muted">
                    Everything in Pro while it lasts, with no card needed.
                    Upgrade any time to keep Pro when the trial ends.
                  </p>
                </div>
                <span className="plan-badge is-pro">Pro trial</span>
              </div>

              <dl className="account-details">
                <div>
                  <dt>Trial ends</dt>
                  <dd>{formatDate(trial.ends_at) ?? "—"}</dd>
                </div>
                <div>
                  <dt>This week</dt>
                  <dd>{formatNumber(used)} words · unlimited</dd>
                </div>
              </dl>

              <p className="account-hint">
                Pro is unlimited for normal dictation; fair use applies.
              </p>
            </section>
          ) : (
            <section className="account-card" aria-labelledby="usage-heading">
              <div className="account-card-head">
                <div>
                  <h2 id="usage-heading">This week</h2>
                  <p className="account-muted">
                    {formatNumber(used)} of {formatNumber(limit)} words this
                    week · resets {resetsAt ?? RESET_LABEL}
                  </p>
                </div>
                <span className="account-card-note">
                  {PLANS.starter.name} plan
                </span>
              </div>

              <div
                className="meter"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={limit}
                aria-valuenow={Math.min(used, limit)}
                aria-label="Weekly word usage"
              >
                <span
                  className={`meter-fill${atLimit ? " is-full" : ""}`}
                  style={{ "--fill": fill.toFixed(4) } as CSSProperties}
                />
              </div>

              <p className={atLimit ? "account-alert" : "account-hint"}>
                {atLimit
                  ? "Weekly limit reached. Upgrade to keep dictating."
                  : `Resets ${RESET_LABEL}. A dictation that crosses the limit keeps the part already transcribed (up to about two minutes) and is counted.`}
              </p>
            </section>
          )}

          {me.free_blocked ? (
            <p className="account-alert" role="status">
              This account can&rsquo;t use the free plan because too many
              accounts were created on one PC. Upgrade to Pro to keep
              dictating.
            </p>
          ) : null}

          {billingIssue ? (
            <section className="account-card" aria-labelledby="billing-heading">
              <div className="account-card-head">
                <div>
                  <h2 id="billing-heading">Payment issue</h2>
                  <p className="account-muted">
                    Update your card to restore Pro. You&rsquo;re on{" "}
                    {PLANS.starter.name} until then.
                  </p>
                </div>
              </div>

              <p className="account-alert" role="status">
                Payment issue: update your card.{" "}
                {BILLING_ISSUE_DETAIL[billingIssue]}
              </p>

              {actionError ? (
                <p className="form-error" role="alert">
                  {actionError}
                </p>
              ) : null}

              <button
                type="button"
                className="btn btn-secondary account-action"
                onClick={actions.onPortal}
                disabled={busy !== null}
                aria-busy={busy === "portal" || undefined}
              >
                <CreditCardIcon size={15} />
                {busy === "portal" ? "Opening…" : "Manage billing"}
              </button>
            </section>
          ) : (
            <section className="account-card" aria-labelledby="upgrade-heading">
              <div className="account-card-head">
                <div>
                  <h2 id="upgrade-heading">
                    {isTrial ? "Keep Pro after your trial" : "Upgrade to Pro"}
                  </h2>
                  <p className="account-muted">
                    Unlimited words for normal dictation. Same fast, clean
                    dictation.
                  </p>
                </div>
              </div>

              <UpgradeOptions
                actions={actions}
                busy={busy}
                blocked={upgradeBlocked}
              />
            </section>
          )}
        </>
      )}

      <section className="account-card account-devices" aria-labelledby="devices-heading">
        <div className="account-card-head">
          <div>
            <h2 id="devices-heading">Devices</h2>
            <p className="account-muted">
              Sign out every desktop copy of Ray connected to this account. This
              browser stays signed in.
            </p>
          </div>
        </div>

        {actions.deviceMessage ? (
          <p className="account-success" role="status">
            {actions.deviceMessage}
          </p>
        ) : null}
        {actions.deviceError ? (
          <p className="form-error" role="alert">
            {actions.deviceError}
          </p>
        ) : null}

        {confirmingDevices ? (
          <div className="account-confirm">
            <p>
              Sign out all devices? Every copy of Ray will need to sign in
              again.
            </p>
            <div className="account-confirm-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setConfirmingDevices(false);
                  actions.onRevokeDevices();
                }}
                disabled={busy !== null}
                aria-busy={busy === "devices" || undefined}
              >
                {busy === "devices"
                  ? "Signing out…"
                  : "Yes, sign out all devices"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirmingDevices(false)}
                disabled={busy === "devices"}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setConfirmingDevices(true);
            }}
            disabled={busy !== null}
            aria-busy={busy === "devices" || undefined}
          >
            <LogOutIcon size={15} />
            {busy === "devices" ? "Signing out…" : "Sign out all devices"}
          </button>
        )}
      </section>

      <section className="account-card account-download">
        <div>
          <h2>Ray for Windows</h2>
          <p className="account-muted">
            The latest installer, ready for Windows 10 or 11.
          </p>
        </div>
        <a className="btn btn-secondary" href={DOWNLOAD_URL}>
          <DownloadIcon size={15} />
          Download
        </a>
      </section>
    </AccountFrame>
  );
}

function AccountPageInner() {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; status: number } | null>(
    null,
  );
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<AccountBusy | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [deviceMessage, setDeviceMessage] = useState<string | null>(null);
  const [activating, setActivating] = useState(
    () =>
      readBillingActivation() ||
      new URLSearchParams(window.location.search).get("activated") === "1",
  );
  const [activationTimedOut, setActivationTimedOut] = useState(false);
  const refreshing = useRef(false);
  const autoCheckoutStarted = useRef(false);

  const searchParams = new URLSearchParams(location.search);
  const intervalParam = searchParams.get("interval");
  const preferredInterval = isBillingInterval(intervalParam)
    ? intervalParam
    : null;

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      // Preserve ?activated=1 / ?interval=… through the sign-in round trip.
      const returnTo = `/account${location.search}`;
      navigate(`/sign-in?redirect_url=${encodeURIComponent(returnTo)}`, {
        replace: true,
      });
    }
  }, [isLoaded, isSignedIn, navigate, location.search]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const token = await getToken();
        if (!token) {
          throw new ApiError(
            401,
            "unauthorized",
            "Your session expired. Sign in again to continue.",
          );
        }
        const data = await fetchMe(token);
        if (!alive) return;
        setMe(data);
        setError(null);
      } catch (caught) {
        if (!alive) return;
        setError({
          message: errorMessage(
            caught,
            "Couldn't reach Ray. Check your connection and try again.",
          ),
          status: caught instanceof ApiError ? caught.status : 0,
        });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isLoaded, isSignedIn, getToken, reload]);

  // Coming back to the tab is the most common moment for a webhook to have
  // landed. Refresh quietly and keep the last good data on a transient error.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let alive = true;

    const refresh = async () => {
      if (document.visibilityState === "hidden" || refreshing.current) return;
      refreshing.current = true;
      try {
        const token = await getToken();
        if (!token) return;
        const data = await fetchMe(token);
        if (!alive) return;
        setMe(data);
        setError(null);
      } catch {
        // A failed focus refresh must not replace a usable account view.
      } finally {
        refreshing.current = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isLoaded, isSignedIn, getToken]);

  // After /billing/success, wait for the Creem webhook to flip the plan. Poll
  // with backoff for roughly 45 seconds, then stop and let a manual refresh
  // finish the job.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !me) return;
    const byQuery =
      new URLSearchParams(location.search).get("activated") === "1";
    const byStorage = readBillingActivation();
    if (!byQuery && !byStorage) return;

    // A trial already resolves as Pro; activation is complete only when the
    // trial has been replaced by a paid subscription.
    if (me.plan === "pro" && !me.trial) {
      clearBillingActivation();
      setActivating(false);
      setActivationTimedOut(false);
      // Keep the account URL clean once activation has been observed.
      if (byQuery) navigate("/account", { replace: true });
      return;
    }

    let cancelled = false;
    let timer = 0;
    let index = 0;
    setActivating(true);
    setActivationTimedOut(false);

    const tick = async () => {
      if (cancelled) return;
      try {
        const token = await getToken();
        if (!token) return;
        const data = await fetchMe(token);
        if (cancelled) return;
        setMe(data);
        setError(null);
        if (data.plan === "pro" && !data.trial) {
          clearBillingActivation();
          setActivating(false);
          setActivationTimedOut(false);
          if (byQuery) navigate("/account", { replace: true });
          return;
        }
      } catch {
        // A 429 or a blip just means the next check is more likely to work.
      }
      index += 1;
      if (index >= ACTIVATION_POLL_DELAYS.length) {
        clearBillingActivation();
        setActivating(false);
        setActivationTimedOut(true);
        return;
      }
      timer = window.setTimeout(
        () => void tick(),
        ACTIVATION_POLL_DELAYS[index],
      );
    };

    timer = window.setTimeout(() => void tick(), ACTIVATION_POLL_DELAYS[0]);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isLoaded, isSignedIn, me?.plan, location.search, getToken, navigate]);

  const openPortal = useCallback(async () => {
    setBusy("portal");
    setActionError(null);
    try {
      const token = await getToken();
      if (!token) {
        throw new ApiError(
          401,
          "unauthorized",
          "Your session expired. Sign in again to continue.",
        );
      }
      const result = await createPortalSession(token);
      if (!isSafeHttpUrl(result.url)) {
        throw new ApiError(
          500,
          "invalid_response",
          "Billing returned an unexpected address. Please try again.",
        );
      }
      window.location.assign(result.url);
    } catch (caught) {
      setBusy(null);
      setActionError(
        errorMessage(caught, "Couldn't open the billing portal. Please try again."),
      );
    }
  }, [getToken]);

  const checkout = useCallback(
    async (interval: BillingInterval) => {
      setBusy(interval);
      setActionError(null);
      try {
        const token = await getToken();
        if (!token) {
          throw new ApiError(
            401,
            "unauthorized",
            "Your session expired. Sign in again to continue.",
          );
        }
        const result = await createCheckout(token, interval);
        if (!isSafeHttpUrl(result.url)) {
          throw new ApiError(
            500,
            "invalid_response",
            "Checkout returned an unexpected address. Please try again.",
          );
        }
        window.location.assign(result.url);
      } catch (caught) {
        setBusy(null);
        if (caught instanceof ApiError && caught.status === 409) {
          if (caught.code === "billing_issue") {
            // The existing subscription needs a payment-method fix first.
            await openPortal();
            return;
          }
          if (caught.code === "checkout_pending") {
            // The first checkout is still waiting for its webhook. Refresh in
            // case it has just landed; otherwise the message explains it.
            setActionError(caught.message);
            setReload((value) => value + 1);
            return;
          }
          // Already subscribed in another tab: refresh instead of a dead end.
          setReload((value) => value + 1);
          return;
        }
        setActionError(
          errorMessage(caught, "Couldn't open checkout. Please try again."),
        );
      }
    },
    [getToken, openPortal],
  );

  // The landing page's "Get Pro" link adds interval + checkout=1 for a
  // signed-in visitor, so the selected interval goes straight to Creem. A
  // trial account is not paid yet, so it may start checkout too.
  useEffect(() => {
    if (
      !isLoaded ||
      !isSignedIn ||
      !me ||
      (me.plan === "pro" && !me.trial)
    )
      return;
    if (me.billing_issue) return;
    // Match the disabled upgrade CTAs: another checkout while activation is
    // pending can create a second subscription and charge the account twice.
    if (activating || activationTimedOut) return;
    const query = new URLSearchParams(location.search);
    if (query.get("checkout") !== "1") return;
    const interval = query.get("interval");
    if (!isBillingInterval(interval) || autoCheckoutStarted.current) return;

    autoCheckoutStarted.current = true;
    // Drop checkout=1 so a refresh or a back-navigation doesn't fire again.
    navigate(`/account?interval=${interval}`, { replace: true });
    void checkout(interval);
  }, [
    isLoaded,
    isSignedIn,
    me,
    location.search,
    navigate,
    checkout,
    activating,
    activationTimedOut,
  ]);

  const revokeDevices = useCallback(async () => {
    setBusy("devices");
    setDeviceError(null);
    setDeviceMessage(null);
    try {
      const token = await getToken();
      if (!token) {
        throw new ApiError(
          401,
          "unauthorized",
          "Your session expired. Sign in again to continue.",
        );
      }
      const { revoked } = await revokeAllDevices(token);
      setDeviceMessage(
        `Signed out ${formatNumber(revoked)} ${
          revoked === 1 ? "device" : "devices"
        }.`,
      );
    } catch (caught) {
      setDeviceError(
        errorMessage(caught, "Couldn't sign out your devices. Please try again."),
      );
    } finally {
      setBusy(null);
    }
  }, [getToken]);

  async function handleSignOut() {
    try {
      await signOut({ redirectUrl: "/" });
    } catch {
      window.location.assign("/");
    }
  }

  if (!isLoaded || (loading && !me)) {
    return (
      <AccountFrame loading>
        <AccountSkeleton />
      </AccountFrame>
    );
  }

  if (!isSignedIn) {
    return (
      <AccountFrame>
        <div className="auth-card auth-message">
          <span className="spinner" aria-hidden="true" />
          <h1>Taking you to sign in…</h1>
          <p>Your account page needs a signed-in session.</p>
        </div>
      </AccountFrame>
    );
  }

  if (error && !me) {
    return (
      <AccountFrame>
        <header className="account-head">
          <div>
            <h1>Account</h1>
          </div>
        </header>
        <div className="auth-card auth-message" role="alert">
          <span className="auth-message-icon is-error" aria-hidden="true">
            <AlertIcon size={20} />
          </span>
          <h1>We couldn&rsquo;t load your account.</h1>
          <p>{error.message}</p>
          <div className="auth-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setReload((value) => value + 1)}
            >
              Try again
            </button>
            {error.status === 401 ? (
              <Link
                className="btn btn-secondary"
                to={`/sign-in?redirect_url=${encodeURIComponent(
                  `/account${location.search}`,
                )}`}
              >
                Sign in again
              </Link>
            ) : null}
          </div>
        </div>
      </AccountFrame>
    );
  }

  if (!me) {
    return (
      <AccountFrame loading>
        <AccountSkeleton />
      </AccountFrame>
    );
  }

  return (
    <AccountView
      me={me}
      actions={{
        busy,
        actionError,
        activating,
        activationTimedOut,
        preferredInterval,
        deviceError,
        deviceMessage,
        onCheckout: (interval) => void checkout(interval),
        onPortal: () => void openPortal(),
        onSignOut: () => void handleSignOut(),
        onRevokeDevices: () => void revokeDevices(),
      }}
    />
  );
}

export function AccountPage() {
  usePageMeta({
    title: "Account",
    description: "Manage your Ray plan, usage, and connected devices.",
    path: "/account",
    noindex: true,
  });
  if (!clerkEnabled) return <AuthNotConfigured />;
  return <AccountPageInner />;
}
