import {
  useCallback,
  useEffect,
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
  type MeResponse,
} from "../lib/api";
import { clerkEnabled } from "../lib/clerk";
import { formatDate, formatNumber, initialsOf } from "../lib/format";
import { usePageTitle } from "../lib/hooks";
import { Link, useNavigate } from "../lib/router";
import {
  DOWNLOAD_URL,
  PLANS,
  proPrice,
  type BillingInterval,
} from "../content";
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
  busy: BillingInterval | "portal" | null;
  actionError: string | null;
  onCheckout: (interval: BillingInterval) => void;
  onPortal: () => void;
  onSignOut: () => void;
}

function AccountView({
  me,
  actions,
}: {
  me: MeResponse;
  actions: AccountActions;
}) {
  const isPro = me.plan === "pro";
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
  const pastDue = me.status === "past_due";
  const monthly = PLANS.pro.monthly;
  const annual = PLANS.pro.annual;
  const { busy, actionError } = actions;

  return (
    <AccountFrame>
      <header className="account-head">
        <div>
          <h1>Account</h1>
          <p>Manage your plan, usage, and Ray install.</p>
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

      <section className="account-card account-profile" aria-label="Profile">
        <span className="account-avatar" aria-hidden="true">
          {initialsOf(me.user.name, me.user.email)}
        </span>
        <div className="account-identity">
          <p className="account-name">{me.user.name || "Ray account"}</p>
          <p className="account-email">
            {me.user.email || "No email on file"}
          </p>
        </div>
        <span className={`plan-badge${isPro ? " is-pro" : ""}`}>
          {isPro ? PLANS.pro.name : PLANS.starter.name}
        </span>
      </section>

      {isPro ? (
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

          {pastDue ? (
            <p className="account-alert" role="status">
              Payment past due. Update your billing details to keep Pro.
            </p>
          ) : null}

          {actionError ? (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          ) : null}

          <button
            type="button"
            className="btn btn-secondary"
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
          <section className="account-card" aria-labelledby="usage-heading">
            <div className="account-card-head">
              <div>
                <h2 id="usage-heading">This week</h2>
                <p className="account-muted">
                  {formatNumber(used)} of {formatNumber(limit)} words this week
                  · resets {PLANS.starter.resetDay}
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
                : `Resets every ${PLANS.starter.resetDay} at ${PLANS.starter.resetTime}. A dictation that crosses the limit still finishes and is counted.`}
            </p>
          </section>

          <section className="account-card" aria-labelledby="upgrade-heading">
            <div className="account-card-head">
              <div>
                <h2 id="upgrade-heading">Upgrade to Pro</h2>
                <p className="account-muted">
                  Unlimited words. Same fast, clean dictation.
                </p>
              </div>
            </div>

            <div className="upgrade-options">
              <button
                type="button"
                className="upgrade-option"
                onClick={() => actions.onCheckout("monthly")}
                disabled={busy !== null}
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
                className="upgrade-option"
                onClick={() => actions.onCheckout("annual")}
                disabled={busy !== null}
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

            {actionError ? (
              <p className="form-error" role="alert">
                {actionError}
              </p>
            ) : null}

            <p className="account-hint">
              Cancel anytime. Payments are handled by Creem, our merchant of
              record.
            </p>
          </section>
        </>
      )}

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
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; status: number } | null>(
    null,
  );
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<BillingInterval | "portal" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      navigate(`/sign-in?redirect_url=${encodeURIComponent("/account")}`, {
        replace: true,
      });
    }
  }, [isLoaded, isSignedIn, navigate]);

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
          message:
            caught instanceof ApiError
              ? caught.message
              : "Couldn't reach Ray. Check your connection and try again.",
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
          // Already subscribed in another tab: refresh instead of a dead end.
          setReload((value) => value + 1);
          return;
        }
        setActionError(
          caught instanceof ApiError
            ? caught.message
            : "Couldn't open checkout. Please try again.",
        );
      }
    },
    [getToken],
  );

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
        caught instanceof ApiError
          ? caught.message
          : "Couldn't open the billing portal. Please try again.",
      );
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
                to={`/sign-in?redirect_url=${encodeURIComponent("/account")}`}
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
        onCheckout: (interval) => void checkout(interval),
        onPortal: () => void openPortal(),
        onSignOut: () => void handleSignOut(),
      }}
    />
  );
}

export function AccountPage() {
  usePageTitle("Account");
  if (!clerkEnabled) return <AuthNotConfigured />;
  return <AccountPageInner />;
}
