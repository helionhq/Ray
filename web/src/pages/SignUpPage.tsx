import { useEffect } from "react";
import { SignUp } from "@clerk/react";
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

function SignUpInner() {
  const location = useLocation();
  const queryRedirect = new URLSearchParams(location.search).get(
    "redirect_url",
  );

  useEffect(() => {
    rememberRedirect(queryRedirect);
  }, [queryRedirect]);

  const exactPath =
    location.pathname !== "/" && location.pathname.endsWith("/")
      ? location.pathname.slice(0, -1)
      : location.pathname;
  const inFlow = Boolean(location.hash) || exactPath !== "/sign-up";
  const redirectUrl =
    safeRedirect(queryRedirect) ??
    (inFlow ? readRememberedRedirect() : null) ??
    "/account";
  const signInUrl = `/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`;

  return (
    <AuthShell>
      <div className="auth-clerk">
        <SignUp
          routing="hash"
          signInUrl={signInUrl}
          forceRedirectUrl={redirectUrl}
          fallbackRedirectUrl={redirectUrl}
          signInForceRedirectUrl={redirectUrl}
          signInFallbackRedirectUrl={redirectUrl}
        />
      </div>
    </AuthShell>
  );
}

export function SignUpPage() {
  usePageTitle("Create an account");
  if (!clerkEnabled) return <AuthNotConfigured />;
  return <SignUpInner />;
}
