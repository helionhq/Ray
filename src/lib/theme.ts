import type { Theme } from "./bridge";

const CACHE_KEY = "ray-theme";
const root = document.documentElement;

export function normalizeTheme(value: unknown): Theme {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

function cacheTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(CACHE_KEY);
    else localStorage.setItem(CACHE_KEY, theme);
  } catch {
    // Private windows and locked-down webviews can refuse storage.
  }
}

let lastApplied: Theme | null = null;

/**
 * Apply a theme to the document. The store's value is
 * authoritative; the cached value only prevents a flash before it arrives.
 *
 * Never call Tauri's `Window.setTheme` here. On Windows, wry implements it via
 * the shared WebView2 profile (`PreferredColorScheme`), so forcing the main
 * window would also repaint the floating bar. The main window is undecorated
 * and draws its own caption, so nothing native needs theming.
 */
export function applyTheme(value: unknown) {
  const theme = normalizeTheme(value);
  if (theme === lastApplied) return;
  lastApplied = theme;

  // A theme switch is a re-skin, not a state change: suppress every colour
  // transition for the next two frames so nothing fades between palettes.
  root.classList.add("theme-switching");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => root.classList.remove("theme-switching"));
  });

  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  cacheTheme(theme);
}
