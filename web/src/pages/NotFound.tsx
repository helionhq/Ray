import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import { DownloadIcon } from "../components/Icons";
import { DOWNLOAD_URL } from "../content";
import { usePageMeta } from "../lib/head";
import { Link } from "../lib/router";

export function NotFoundPage() {
  usePageMeta({
    title: "Page not found",
    description: "The page you were looking for doesn't exist.",
    path: "/404",
    noindex: true,
  });

  return (
    <div className="site">
      <SiteHeader />
      <main id="main" className="page-main" tabIndex={-1}>
        <div className="container notfound">
          <p className="eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            404
          </p>
          <h1>This page went quiet.</h1>
          <p>
            The link may be old, or the page may have moved. Ray is still right
            where you left it.
          </p>
          <div className="hero-actions">
            <Link className="btn btn-primary" to="/">
              Back home
            </Link>
            <a className="btn btn-secondary" href={DOWNLOAD_URL}>
              <DownloadIcon size={15} />
              Download Ray
            </a>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
