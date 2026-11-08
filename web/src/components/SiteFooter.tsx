import { Link } from "../lib/router";
import { REPOSITORY_URL } from "../content";
import { RayLogo } from "./RayLogo";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="site-footer-top">
          <div className="site-footer-brand">
            <Link to="/" aria-label="Ray home">
              <RayLogo width={78} height={26} />
            </Link>
            <p>Fast, clean dictation for Windows.</p>
          </div>
          <nav className="site-footer-links" aria-label="Footer">
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
            <a href={REPOSITORY_URL} rel="noreferrer">
              GitHub
            </a>
          </nav>
        </div>
        <div className="site-footer-bottom">
          <span>© Helion</span>
          <span>Windows 10 &amp; 11</span>
        </div>
      </div>
    </footer>
  );
}
