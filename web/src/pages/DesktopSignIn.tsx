import { useEffect, useMemo, useRef, useState } from "react";
import { SignIn, useAuth, useUser } from "@clerk/react";
import { AuthShell } from "../components/AuthShell";
import { AuthNotConfigured } from "../components/AuthNotConfigured";
import {
  AlertIcon,
  ArrowRightIcon,
  CheckIcon,
  DownloadIcon,
} from "../components/Icons";
import {
  ApiError,
  authorizeDesktop,
  isRayAuthRedirect,
  type DesktopAuthorizeResponse,
} from "../lib/api";
import {
  desktopSignInPath,
  validDesktopParams,
  type DesktopParams,
} from "../lib/auth-redirect";
import { clerkEnabled } from "../lib/clerk";
import { usePageMeta } from "../lib/head";
import { Link, useLocation } from "../lib/router";
import { DOWNLOAD_URL } from "../content";

const STORAGE_KEY = "ray.desktop.authorize";
const PARAMS_MAX_AGE_MS = 10 * 60 * 1000;

function readStoredParams(): DesktopParams | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DesktopParams> & {
      savedAt?: unknown;
    };
    if (
      typeof parsed.savedAt !== "number" ||
      Date.now() - parsed.savedAt > PARAMS_MAX_AGE_MS
    ) {
      return null;
    }
    return validDesktopParams(parsed.state ?? null, parsed.challenge ?? null);
  } catch {
    return null;
  }
}

function resolveParams(search: string): DesktopParams | null {
  const query = new URLSearchParams(search);
  return (
    validDesktopParams(query.get("state"), query.get("challenge")) ??
    readStoredParams()
  );
}

function ConsentView({
  email,
  signingOut,
  onContinue,
  onUseDifferentAccount,
}: {
  email: string;
  signingOut: boolean;
  onContinue: () => void;
  onUseDifferentAccount: () => void;
}) {
  return (
    <AuthShell>
      <div className="auth-card auth-message">
        <span className="auth-message-icon is-ok" aria-hidden="true">
          <CheckIcon size={20} />
        </span>
        <h1>Continue as {email}</h1>
        <p>
          Ray for Windows is waiting to connect to this account. Only continue
          if you started sign-in from the Ray app on this PC.
        </p>
        <div className="auth-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onContinue}
            disabled={signingOut}
          >
            Continue
            <ArrowRightIcon size={15} />
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost auth-switch-account"
          onClick={onUseDifferentAccount}
          disabled={signingOut}
        >
          {signingOut ? "Signing out…" : "Use a different account"}
        </button>
        <p className="auth-message-hint">
          Ray never sees your password. Choosing a different account signs you
          out here and brings back the sign-in form.
        </p>
      </div>
    </AuthShell>
  );
}

function DesktopSignInInner() {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth();
  const { user } = useUser();
  const { search } = useLocation();
  const params = useMemo(() => resolveParams(search), [search]);
  const [status, setStatus] = useState<
    "idle" | "working" | "success" | "error"
  >("idle");
  const [redirect, setRedirect] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; status: number } | null>(
    null,
  );
  const [signingOut, setSigningOut] = useState(false);
  const opened = useRef<string | null>(null);
  // One authorize request per click, even if the button gets a rapid second
  // click before React re-renders the disabled state.
  const inFlight = useRef<Promise<DesktopAuthorizeResponse> | null>(null);

  const desktopUrl = useMemo(
    () =>
      params
        ? `${window.location.origin}${desktopSignInPath(params)}`
        : `${window.location.origin}/desktop/sign-in`,
    [params],
  );

  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    "your Ray account";

  // Keep the hand-off parameters for the rest of the browser session. Clerk's
  // own flow can move the hash around; the query is what Ray needs back.
  useEffect(() => {
    if (!params) return;
    try {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...params, savedAt: Date.now() }),
      );
    } catch {
      // Storage can be blocked; the URL still has what we need.
    }
  }, [params]);

  // Hand off once. The custom protocol may show a browser prompt instead of
  // navigating, which is why the Open Ray button stays on screen.
  useEffect(() => {
    if (status !== "success" || !redirect) return;
    if (opened.current === redirect) return;
    opened.current = redirect;
    try {
      window.location.href = redirect;
    } catch {
      // Custom schemes can be blocked; the button remains for a user gesture.
    }
  }, [status, redirect]);

  /**
   * Consent is always explicit: `/desktop/sign-in` never authorizes just
   * because someone is signed in. Without a click, a phishing page could
   * silently bind a victim's account to an attacker's Ray install.
   */
  function startAuthorize() {
    if (!params || inFlight.current) return;

    setError(null);
    setRedirect(null);
    setStatus("working");

    const request = (async () => {
      const token = await getToken();
      if (!token) {
        throw new ApiError(
          401,
          "unauthorized",
          "Your session expired. Start sign-in again from the Ray app.",
        );
      }
      const result = await authorizeDesktop(
        token,
        params.state,
        params.challenge,
      );
      if (!isRayAuthRedirect(result.redirect)) {
        throw new ApiError(
          500,
          "invalid_response",
          "Ray returned an unexpected sign-in redirect.",
        );
      }
      return result;
    })();

    inFlight.current = request;
    request
      .then((result) => {
        setRedirect(result.redirect);
        setStatus("success");
      })
      .catch((caught: unknown) => {
        setError({
          message:
            caught instanceof ApiError
              ? caught.message
              : "Couldn't finish connecting Ray. Start sign-in again from the app.",
          status: caught instanceof ApiError ? caught.status : 0,
        });
        setStatus("error");
      })
      .finally(() => {
        inFlight.current = null;
      });
  }

  /** Sign out here, then show Clerk's sign-in form again with the same params. */
  async function useDifferentAccount() {
    if (!params || signingOut) return;
    setSigningOut(true);
    setError(null);
    setRedirect(null);
    setStatus("idle");
    try {
      // Keep state/challenge in the URL through the sign-out redirect.
      await signOut({ redirectUrl: desktopUrl });
    } catch {
      window.location.assign(desktopUrl);
    } finally {
      setSigningOut(false);
    }
  }

  if (!params) {
    return (
      <AuthShell>
        <div className="auth-card auth-message">
          <span className="auth-message-icon is-error" aria-hidden="true">
            <AlertIcon size={20} />
          </span>
          <h1>This sign-in link is incomplete.</h1>
          <p>
            Start sign-in again from the Ray app. These links are short-lived
            and can only be used once.
          </p>
          <div className="auth-actions">
            <a className="btn btn-primary" href={DOWNLOAD_URL}>
              <DownloadIcon size={15} />
              Download Ray
            </a>
            <Link className="btn btn-secondary" to="/">
              Back to the site
            </Link>
          </div>
        </div>
      </AuthShell>
    );
  }

  if (!isLoaded) {
    return (
      <AuthShell>
        <div className="auth-card auth-message">
          <span className="spinner" aria-hidden="true" />
          <h1>Checking your session…</h1>
          <p>One moment while we talk to Clerk.</p>
        </div>
      </AuthShell>
    );
  }

  if (!isSignedIn) {
    // Carry state/challenge both inside Clerk's redirect URL and directly on
    // the sign-up URL: an email-verification link can open in a fresh tab
    // where sessionStorage is empty.
    const signUpUrl = `${window.location.origin}/sign-up?state=${encodeURIComponent(
      params.state,
    )}&challenge=${encodeURIComponent(
      params.challenge,
    )}&redirect_url=${encodeURIComponent(desktopUrl)}`;

    return (
      <AuthShell>
        <div className="auth-flow">
          <div className="auth-intro">
            <span className="auth-step">Desktop sign-in</span>
            <h1>Connect Ray for Windows</h1>
            <p>
              Sign in with the account you want to use in Ray. The app is
              waiting for you.
            </p>
          </div>
          <div className="auth-clerk">
            <SignIn
              routing="hash"
              forceRedirectUrl={desktopUrl}
              fallbackRedirectUrl={desktopUrl}
              signUpUrl={signUpUrl}
              signUpForceRedirectUrl={desktopUrl}
              signUpFallbackRedirectUrl={desktopUrl}
            />
          </div>
          <p className="auth-hint">
            Use the same browser to finish. Ray never sees your password.
          </p>
        </div>
      </AuthShell>
    );
  }

  if (status === "success" && redirect) {
    return (
      <AuthShell>
        <div className="auth-card auth-message" role="status">
          <span className="auth-message-icon is-ok" aria-hidden="true">
            <CheckIcon size={20} />
          </span>
          <h1>You&rsquo;re signed in. Return to Ray.</h1>
          <p>
            The app should open automatically. If your browser blocked it, use
            the button below.
          </p>
          <div className="auth-actions">
            <a className="btn btn-primary" href={redirect}>
              Open Ray
              <ArrowRightIcon size={15} />
            </a>
          </div>
          <p className="auth-message-hint">
            Still nothing? Close this tab and start sign-in again from the Ray
            app.
          </p>
        </div>
      </AuthShell>
    );
  }

  if (status === "working") {
    return (
      <AuthShell>
        <div className="auth-card auth-message" role="status">
          <span className="spinner" aria-hidden="true" />
          <h1>Finishing sign-in…</h1>
          <p>
            Holding the browser open while we hand your session back to Ray.
          </p>
        </div>
      </AuthShell>
    );
  }

  if (status === "error" && error) {
    const canRetry =
      error.status === 0 || error.status === 401 || error.status === 429 ||
      error.status >= 500;
    return (
      <AuthShell>
        <div className="auth-card auth-message" role="alert">
          <span className="auth-message-icon is-error" aria-hidden="true">
            <AlertIcon size={20} />
          </span>
          <h1>Couldn&rsquo;t finish connecting Ray.</h1>
          <p>{error.message}</p>
          <p className="auth-message-hint">
            Start sign-in again from the Ray app. The link may have expired, or
            the session may already be in use.
          </p>
          <div className="auth-actions">
            {canRetry ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setError(null);
                  setStatus("idle");
                }}
              >
                Try again
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void useDifferentAccount()}
              disabled={signingOut}
            >
              {signingOut ? "Signing out…" : "Use a different account"}
            </button>
            <Link className="btn btn-secondary" to="/">
              Back to the site
            </Link>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <ConsentView
      email={email}
      signingOut={signingOut}
      onContinue={startAuthorize}
      onUseDifferentAccount={() => void useDifferentAccount()}
    />
  );
}

export function DesktopSignInPage() {
  usePageMeta({
    title: "Desktop sign-in",
    description: "Connect Ray for Windows to your Ray account.",
    path: "/desktop/sign-in",
    noindex: true,
  });
  if (!clerkEnabled) return <AuthNotConfigured />;
  return <DesktopSignInInner />;
}
