import { useEffect } from "react";
import { SignIn } from "@clerk/react";
import { AuthShell } from "../components/AuthShell";
import { AuthNotConfigured } from "../components/AuthNotConfigured";
import { clerkEnabled } from "../lib/clerk";
import { usePageMeta } from "../lib/head";
import { useLocation } from "../lib/router";
import {
  desktopRedirectFromSearch,
  readRememberedRedirect,
  rememberRedirect,
  safeRedirect,
} from "../lib/auth-redirect";

function SignInInner() {
  const location = useLocation();
  const queryRedirect = new URLSearchParams(location.search).get(
    "redirect_url",
  );

  // state/challenge may be on this URL when a Clerk email link opened in a
  // new tab, where sessionStorage from the original tab isn't available.
  const desktopRedirect = desktopRedirectFromSearch(location.search);

  useEffect(() => {
    // Remember the direct desktop params too, in case Clerk's flow drops the
    // query while it moves the hash around.
    rememberRedirect(queryRedirect ?? desktopRedirect);
  }, [queryRedirect, desktopRedirect]);

  // Only fall back to the remembered destination once Clerk has started its
  // own flow; a fresh visit shouldn't inherit an old tab's redirect.
  const exactPath =
    location.pathname !== "/" && location.pathname.endsWith("/")
      ? location.pathname.slice(0, -1)
      : location.pathname;
  const inFlow = Boolean(location.hash) || exactPath !== "/sign-in";
  const redirectUrl =
    safeRedirect(queryRedirect) ??
    desktopRedirect ??
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
  usePageMeta({
    title: "Sign in",
    description: "Sign in to your Ray account.",
    path: "/sign-in",
    noindex: true,
  });
  if (!clerkEnabled) return <AuthNotConfigured />;
  return <SignInInner />;
}
