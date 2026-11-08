import { useAuth } from "@clerk/react";
import { clerkEnabled } from "../lib/clerk";
import { Link, useLocation } from "../lib/router";
import { DOWNLOAD_URL, NAV_LINKS } from "../content";
import { DownloadIcon } from "./Icons";
import { RayLogo } from "./RayLogo";

function HeaderAuth() {
  if (!clerkEnabled) {
    return (
      <Link className="site-nav-link site-nav-signin" to="/sign-in">
        Sign in
      </Link>
    );
  }
  return <ClerkHeaderAuth />;
}

function ClerkHeaderAuth() {
  const { isLoaded, isSignedIn } = useAuth();
  return (
    <Link
      className="site-nav-link site-nav-signin"
      to={isLoaded && isSignedIn ? "/account" : "/sign-in"}
    >
      {isLoaded && isSignedIn ? "Account" : "Sign in"}
    </Link>
  );
}

export function SiteHeader() {
  const { pathname } = useLocation();
  const onLanding = pathname === "/" || pathname === "";

  return (
    <header className="site-header">
      <div className="container site-header-inner">
        <Link className="brand" to="/" aria-label="Ray home">
          <RayLogo width={78} height={26} />
        </Link>

        <nav className="site-nav" aria-label="Primary">
          {NAV_LINKS.map((item) =>
            onLanding ? (
              <a
                key={item.href}
                className="site-nav-link"
                href={item.href.replace("/", "")}
              >
                {item.label}
              </a>
            ) : (
              <Link key={item.href} className="site-nav-link" to={item.href}>
                {item.label}
              </Link>
            ),
          )}
        </nav>

        <div className="site-header-actions">
          <HeaderAuth />
          <a className="btn btn-primary btn-sm" href={DOWNLOAD_URL}>
            <DownloadIcon size={15} />
            Download
          </a>
        </div>
      </div>
    </header>
  );
}
