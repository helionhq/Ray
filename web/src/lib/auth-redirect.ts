const KEY = "ray.auth.redirect";
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

export interface DesktopParams {
  state: string;
  challenge: string;
}

export function isBase64Url(value: string | null): value is string {
  return typeof value === "string" && BASE64URL_43.test(value);
}

/**
 * The desktop hand-off params can arrive directly on a sign-in/sign-up URL
 * (we add them there so an email-verification link opened in a new tab still
 * knows where to return). They are only accepted when well formed.
 */
export function validDesktopParams(
  state: string | null,
  challenge: string | null,
): DesktopParams | null {
  if (isBase64Url(state) && isBase64Url(challenge)) {
    return { state, challenge };
  }
  return null;
}

export function desktopSignInPath(params: DesktopParams): string {
  return `/desktop/sign-in?state=${encodeURIComponent(
    params.state,
  )}&challenge=${encodeURIComponent(params.challenge)}`;
}

/** Returns the desktop hand-off return path encoded in `search`, if any. */
export function desktopRedirectFromSearch(search: string): string | null {
  const query = new URLSearchParams(search);
  const params = validDesktopParams(query.get("state"), query.get("challenge"));
  return params ? desktopSignInPath(params) : null;
}

/**
 * Clerk's web flow can move the URL around while a factor is completed. Keep
 * the intended destination in sessionStorage so a page reload still returns
 * people to the right place — and never accept an off-site destination.
 */
export function safeRedirect(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function rememberRedirect(value: string | null) {
  const safe = safeRedirect(value);
  if (!safe) return;
  try {
    window.sessionStorage.setItem(KEY, safe);
  } catch {
    // Storage can be unavailable; the URL query remains the primary source.
  }
}

export function readRememberedRedirect(): string | null {
  try {
    return safeRedirect(window.sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
}
