import { useEffect } from "react";
import { AuthShell } from "../components/AuthShell";
import { ArrowRightIcon, CheckIcon } from "../components/Icons";
import { BILLING_SUCCESS_DEEPLINK } from "../content";
import { usePageTitle } from "../lib/hooks";
import { Link } from "../lib/router";

// One automatic hand-off per page load. StrictMode's first timer is cleared
// by cleanup, so this flag is set when the navigation actually fires.
let attemptedThisLoad = false;

export function BillingSuccessPage() {
  usePageTitle("Billing success");

  useEffect(() => {
    if (attemptedThisLoad) return;
    const timer = window.setTimeout(() => {
      if (attemptedThisLoad) return;
      attemptedThisLoad = true;
      try {
        window.location.href = BILLING_SUCCESS_DEEPLINK;
      } catch {
        // The Open Ray button covers a browser that blocks custom schemes.
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <AuthShell>
      <div className="auth-card auth-message" role="status">
        <span className="auth-message-icon is-ok" aria-hidden="true">
          <CheckIcon size={20} />
        </span>
        <h1>Payment received.</h1>
        <p>
          Thanks for upgrading. Your Pro plan is being set up — it can take a
          moment to appear on your account and in Ray.
        </p>
        <div className="auth-actions">
          <a className="btn btn-primary" href={BILLING_SUCCESS_DEEPLINK}>
            Open Ray
            <ArrowRightIcon size={15} />
          </a>
          <Link className="btn btn-secondary" to="/account">
            Go to Account
          </Link>
        </div>
        <p className="auth-message-hint">
          Ray should open automatically. If it doesn&rsquo;t, click Open Ray.
          Your account updates either way.
        </p>
      </div>
    </AuthShell>
  );
}
