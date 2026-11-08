import { useEffect } from "react";
import { SignIn } from "@clerk/react";
import { AuthShell } from "../components/AuthShell";
import { AuthNotConfigured } from "../components/AuthNotConfigured";
import { clerkEnabled } from "../lib/clerk";
import { usePageTitle } from "../lib/hooks";
import { useLocation } from "../lib/router";
import {
  readRememberedRedirect,
  rememberRedirect,
  safeRedirect,
} from "../lib/auth-redirect";

function SignInInner() {
  const location = useLocation();
  const queryRedirect = new URLSearchParams(location.search).get(
    "redirect_url",
  );

  useEffect(() => {
    rememberRedirect(queryRedirect);
  }, [queryRedirect]);

  // Only fall back to the remembered destination once Clerk has started its
  // own flow; a fresh visit shouldn't inherit an old tab's redirect.
  const exactPath =
    location.pathname !== "/" && location.pathname.endsWith("/")
      ? location.pathname.slice(0, -1)
      : location.pathname;
  const inFlow = Boolean(location.hash) || exactPath !== "/sign-in";
  const redirectUrl =
    safeRedirect(queryRedirect) ??
    (inFlow ? readRememberedRedirect() : null) ??
    "/account";
  const signUpUrl = `/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`;

  return (
    <AuthShell>
      <div className="auth-clerk">
        <SignIn
          routing="hash"
          signUpUrl={signUpUrl}
          forceRedirectUrl={redirectUrl}
          fallbackRedirectUrl={redirectUrl}
          signUpForceRedirectUrl={redirectUrl}
          signUpFallbackRedirectUrl={redirectUrl}
        />
      </div>
    </AuthShell>
  );
}

export function SignInPage() {
  usePageTitle("Sign in");
  if (!clerkEnabled) return <AuthNotConfigured />;
  return <SignInInner />;
}
