const rawKey = (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? "").trim();

/**
 * A missing (or obviously malformed) key must not take the marketing site
 * down. Clerk only mounts when there is something real to initialize with;
 * auth pages render a plain "not configured" notice otherwise.
 */
export const clerkPublishableKey = rawKey;
export const clerkEnabled =
  rawKey.startsWith("pk_") && rawKey.length > 24;

/**
 * Monochrome Clerk theming, deliberately close to the desktop app: ink
 * primary, Geist, 10px radii, no brand purple anywhere.
 */
export function clerkAppearance(dark: boolean) {
  return {
    variables: {
      colorPrimary: dark ? "#ededef" : "#18181b",
      colorPrimaryForeground: dark ? "#0b0b0c" : "#ffffff",
      colorBackground: dark ? "#151517" : "#ffffff",
      colorForeground: dark ? "#ededef" : "#18181b",
      colorMutedForeground: dark ? "#a1a1aa" : "#52525b",
      colorMuted: dark ? "#1b1b1e" : "#fafafa",
      colorInput: dark ? "#0b0b0c" : "#ffffff",
      colorInputForeground: dark ? "#ededef" : "#18181b",
      colorNeutral: dark ? "#ededef" : "#18181b",
      colorBorder: dark ? "#2e2e33" : "#e4e4e7",
      colorRing: dark ? "rgba(255,255,255,0.18)" : "rgba(24,24,27,0.16)",
      colorDanger: dark ? "#ff5c63" : "#c42b1c",
      colorSuccess: dark ? "#4ade80" : "#16a34a",
      borderRadius: "10px",
      fontFamily: '"Geist Variable", "Geist", "Segoe UI", system-ui, sans-serif',
      fontFamilyButtons:
        '"Geist Variable", "Geist", "Segoe UI", system-ui, sans-serif',
      fontSize: "14px",
      spacing: "1rem",
    },
    elements: {
      card: "ray-clerk-card",
      headerTitle: "ray-clerk-title",
      headerSubtitle: "ray-clerk-subtitle",
      formButtonPrimary: "ray-clerk-primary",
      socialButtonsBlockButton: "ray-clerk-social",
      formFieldInput: "ray-clerk-input",
      footerActionLink: "ray-clerk-link",
    },
  };
}

export type ClerkAppearance = ReturnType<typeof clerkAppearance>;
