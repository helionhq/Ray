import { useEffect } from "react";
import { SignUp } from "@clerk/react";
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

function SignUpInner() {
  const location = useLocation();
  const queryRedirect = new URLSearchParams(location.search).get(
    "redirect_url",
  );

  // The desktop hand-off puts state/challenge directly on this URL as well,
  // so an email-verification link opened in a new tab keeps them.
  const desktopRedirect = desktopRedirectFromSearch(location.search);

  useEffect(() => {
    // Remember the direct desktop params too, in case Clerk's flow drops the
    // query while it moves the hash around.
    rememberRedirect(queryRedirect ?? desktopRedirect);
  }, [queryRedirect, desktopRedirect]);

  const exactPath =
    location.pathname !== "/" && location.pathname.endsWith("/")
      ? location.pathname.slice(0, -1)
      : location.pathname;
  const inFlow = Boolean(location.hash) || exactPath !== "/sign-up";
  const redirectUrl =
    safeRedirect(queryRedirect) ??
    desktopRedirect ??
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
  usePageMeta({
    title: "Create an account",
    description: "Create your Ray account and start dictating free.",
    path: "/sign-up",
    noindex: true,
  });
  if (!clerkEnabled) return <AuthNotConfigured />;
  return <SignUpInner />;
}
