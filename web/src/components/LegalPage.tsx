import type { ReactNode } from "react";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import { AlertIcon } from "../components/Icons";

export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="site">
      <SiteHeader />
      <main id="main" className="page-main" tabIndex={-1}>
        <div className="container legal-page">
          <p className="legal-draft">
            <AlertIcon size={15} />
            Draft — pending legal review
          </p>
          <h1>{title}</h1>
          <p className="legal-updated">Last updated {updated}</p>
          <div className="prose">{children}</div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
