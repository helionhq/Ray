const KEY = "ray.billing.activated";

/**
 * Set by `/billing/success` so `/account` keeps polling even if a sign-in
 * redirect or a reload drops the `?activated=1` query.
 */
export function rememberBillingActivation() {
  try {
    window.sessionStorage.setItem(KEY, "1");
  } catch {
    // Storage can be blocked; the query parameter still carries the intent.
  }
}

export function readBillingActivation(): boolean {
  try {
    return window.sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function clearBillingActivation() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clean up.
  }
}
