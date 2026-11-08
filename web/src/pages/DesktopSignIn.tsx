import { useEffect, useMemo, useRef, useState } from "react";
import { SignIn, useAuth } from "@clerk/react";
import { AuthShell } from "../components/AuthShell";
import { AuthNotConfigured } from "../components/AuthNotConfigured";
import { AlertIcon, ArrowRightIcon, CheckIcon, DownloadIcon } from "../components/Icons";
import {
  ApiError,
  authorizeDesktop,
  isRayAuthRedirect,
  type DesktopAuthorizeResponse,
} from "../lib/api";
import { clerkEnabled } from "../lib/clerk";
import { usePageTitle } from "../lib/hooks";
import { Link, useLocation } from "../lib/router";
import { DOWNLOAD_URL } from "../content";

const STORAGE_KEY = "ray.desktop.authorize";
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

interface DesktopParams {
  state: string;
  challenge: string;
}

const PARAMS_MAX_AGE_MS = 10 * 60 * 1000;

/** One network call per state/challenge, even through StrictMode remounts. */
const authorizeCache = new Map<string, Promise<DesktopAuthorizeResponse>>();

function isBase64Url(value: string | null): value is string {
  return typeof value === "string" && BASE64URL_43.test(value);
}

function validParams(state: string | null, challenge: string | null) {
  if (isBase64Url(state) && isBase64Url(challenge)) {
    return { state, challenge } satisfies DesktopParams;
  }
  return null;
}

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
    return validParams(parsed.state ?? null, parsed.challenge ?? null);
  } catch {
    return null;
  }
}

function resolveParams(search: string): DesktopParams | null {
  const query = new URLSearchParams(search);
  return (
    validParams(query.get("state"), query.get("challenge")) ??
    readStoredParams()
  );
}

function authorizeOnce(
  params: DesktopParams,
  getToken: () => Promise<string | null>,
) {
  const key = `${params.state}.${params.challenge}`;
  const existing = authorizeCache.get(key);
  if (existing) return existing;

  const request = (async () => {
    const token = await getToken();
    if (!token) {
      throw new ApiError(
        401,
        "unauthorized",
        "Your session expired. Start sign-in again from the Ray app.",
      );
    }
    const result = await authorizeDesktop(token, params.state, params.challenge);
    if (!isRayAuthRedirect(result.redirect)) {
      throw new ApiError(
        500,
        "invalid_response",
        "Ray returned an unexpected sign-in redirect.",
      );
    }
    return result;
  })();

  authorizeCache.set(key, request);
  request.catch(() => {
    // Let a deliberate retry make a fresh call; the initial mount still
    // shares one promise between StrictMode's two effect runs.
    authorizeCache.delete(key);
  });
  return request;
}

function DesktopSignInInner() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { search } = useLocation();
  const params = useMemo(() => resolveParams(search), [search]);
  const [status, setStatus] = useState<
    "idle" | "working" | "success" | "error"
  >("idle");
  const [redirect, setRedirect] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; status: number } | null>(
    null,
  );
  const opened = useRef<string | null>(null);

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

  useEffect(() => {
    if (!params || !isLoaded || !isSignedIn || status !== "idle") return;
    setStatus("working");
    authorizeOnce(params, getToken)
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
      });
    // The shared promise means this effect can safely run twice under
    // StrictMode; both callbacks settle the same request.
  }, [params, isLoaded, isSignedIn, getToken, status]);

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
    const desktopUrl = `${window.location.origin}/desktop/sign-in?state=${encodeURIComponent(
      params.state,
    )}&challenge=${encodeURIComponent(params.challenge)}`;
    const signUpUrl = `${window.location.origin}/sign-up?redirect_url=${encodeURIComponent(
      desktopUrl,
    )}`;

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
          <span
            className="auth-message-icon is-ok"
            aria-hidden="true"
          >
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

  if (status === "error" && error) {
    const canRetry = error.status === 0 || error.status >= 500;
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
            <Link className="btn btn-secondary" to="/">
              Back to the site
            </Link>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="auth-card auth-message" role="status">
        <span className="spinner" aria-hidden="true" />
        <h1>Finishing sign-in…</h1>
        <p>Holding the browser open while we hand your session back to Ray.</p>
      </div>
    </AuthShell>
  );
}

export function DesktopSignInPage() {
  usePageTitle("Connect Ray");
  if (!clerkEnabled) return <AuthNotConfigured />;
  return <DesktopSignInInner />;
}
