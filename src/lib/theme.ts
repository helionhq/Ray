import { api, hasTauri } from "./bridge";
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
let activeTheme: Theme = "system";
let listenersAttached = false;

function effectiveDark(theme: Theme): boolean {
  if (theme === "light") return false;
  if (theme === "dark") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function syncTitleBar(theme: Theme) {
  if (!hasTauri()) return;
  try {
    void api.setTitleBarDark(effectiveDark(theme)).catch(() => {});
  } catch {
    // The title bar is cosmetic; a failed DWM call must never block theming.
  }
}

function attachThemeListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (activeTheme === "system") syncTitleBar("system");
    });

  // tao can reset the DWM attribute on WM_SETTINGCHANGE while the window is
  // in the background, so re-apply whenever the main window comes forward.
  window.addEventListener("focus", () => syncTitleBar(activeTheme));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncTitleBar(activeTheme);
  });
}

/**
 * Apply a theme to the document and the native title bar. The store's value is
 * authoritative; the cached value only prevents a flash before it arrives.
 *
 * Never call Tauri's `Window.setTheme` here. On Windows, wry implements it via
 * the shared WebView2 profile (`PreferredColorScheme`), so forcing the main
 * window would also repaint the floating bar. The title bar is themed with a
 * DWM-only command instead.
 */
export function applyTheme(value: unknown) {
  const theme = normalizeTheme(value);
  if (theme === lastApplied) return;
  lastApplied = theme;
  activeTheme = theme;
  attachThemeListeners();

  // A theme switch is a re-skin, not a state change: suppress every colour
  // transition for the next two frames so nothing fades between palettes.
  root.classList.add("theme-switching");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => root.classList.remove("theme-switching"));
  });

  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  cacheTheme(theme);
  syncTitleBar(theme);
}
