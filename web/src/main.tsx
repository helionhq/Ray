import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import App from "./App";
import { usePrefersDark } from "./lib/hooks";
import {
  clerkAppearance,
  clerkEnabled,
  clerkPublishableKey,
} from "./lib/clerk";
import { clerkRouterPush, clerkRouterReplace } from "./lib/router";

function Root() {
  const dark = usePrefersDark();

  if (!clerkEnabled) return <App />;

  return (
    <ClerkProvider
      publishableKey={clerkPublishableKey}
      appearance={clerkAppearance(dark)}
      routerPush={clerkRouterPush}
      routerReplace={clerkRouterReplace}
      afterSignOutUrl="/"
    >
      <App />
    </ClerkProvider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
