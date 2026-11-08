const KEY = "ray.auth.redirect";

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
