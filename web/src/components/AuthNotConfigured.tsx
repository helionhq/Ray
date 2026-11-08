import { Link } from "../lib/router";
import { AuthShell } from "./AuthShell";
import { AlertIcon } from "./Icons";

export function AuthNotConfigured() {
  return (
    <AuthShell>
      <div className="auth-card auth-message">
        <span className="auth-message-icon" aria-hidden="true">
          <AlertIcon size={20} />
        </span>
        <h1>Auth isn&rsquo;t configured</h1>
        <p>
          This build of the site doesn&rsquo;t have a Clerk publishable key, so
          sign-in can&rsquo;t start. The marketing pages still work.
        </p>
        <code className="code-callout">VITE_CLERK_PUBLISHABLE_KEY</code>
        <p className="auth-message-hint">
          Set it in <code>web/.env</code> and restart the dev server, or set it
          as a variable on the deployed Worker.
        </p>
        <Link className="btn btn-secondary" to="/">
          Back to the site
        </Link>
      </div>
    </AuthShell>
  );
}
