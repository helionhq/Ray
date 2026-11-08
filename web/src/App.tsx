import { useEffect } from "react";
import { isPath, useLocation, useRouteScroll } from "./lib/router";
import { LandingPage } from "./pages/Landing";
import { SignInPage } from "./pages/SignInPage";
import { SignUpPage } from "./pages/SignUpPage";
import { DesktopSignInPage } from "./pages/DesktopSignIn";
import { AccountPage } from "./pages/Account";
import { BillingSuccessPage } from "./pages/BillingSuccess";
import { PrivacyPage } from "./pages/Privacy";
import { TermsPage } from "./pages/Terms";
import { NotFoundPage } from "./pages/NotFound";

export default function App() {
  useRouteScroll();
  const location = useLocation();

  // Route changes replace the document; move focus to the new main region so
  // keyboard and screen-reader users start at the top of the new page.
  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [location.pathname]);

  let page;
  if (
    location.pathname === "/" ||
    location.pathname === "" ||
    location.pathname === "/index.html"
  ) {
    page = <LandingPage />;
  } else if (isPath(location.pathname, "/sign-in")) {
    page = <SignInPage />;
  } else if (isPath(location.pathname, "/sign-up")) {
    page = <SignUpPage />;
  } else if (isPath(location.pathname, "/desktop/sign-in")) {
    page = <DesktopSignInPage />;
  } else if (isPath(location.pathname, "/account")) {
    page = <AccountPage />;
  } else if (isPath(location.pathname, "/billing/success")) {
    page = <BillingSuccessPage />;
  } else if (isPath(location.pathname, "/privacy")) {
    page = <PrivacyPage />;
  } else if (isPath(location.pathname, "/terms")) {
    page = <TermsPage />;
  } else {
    page = <NotFoundPage />;
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {page}
    </>
  );
}
