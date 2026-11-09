import type { ReactNode } from "react";
import { Link } from "../lib/router";
import { RayLogo } from "./RayLogo";

/** Minimal chrome for sign-in, hand-off, and billing screens. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <header className="auth-header">
        <div className="container auth-header-inner">
          <Link className="brand" to="/" aria-label="Ray home">
            <RayLogo width={72} height={24} />
          </Link>
          <Link className="auth-back" to="/">
            Back to the site
          </Link>
        </div>
      </header>

      <main id="main" className="auth-main" tabIndex={-1}>
        {children}
      </main>

      <footer className="auth-footer">
        <Link to="/privacy">Privacy</Link>
        <span aria-hidden="true">·</span>
        <Link to="/terms">Terms</Link>
        <span aria-hidden="true">·</span>
        <span>© Helion</span>
      </footer>
    </div>
  );
}
