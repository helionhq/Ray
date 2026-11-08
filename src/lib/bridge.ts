import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface HistoryEntry {
  id: string;
  created_at: number;
  text: string;
  raw: string | null;
  app: string | null;
  duration_ms: number;
  /** "structured" when cleanup ran; null for raw/legacy entries. */
  mode: string | null;
}

export interface InputDevice {
  id: string;
  name: string;
  is_default: boolean;
}

export type Theme = "system" | "light" | "dark";

/**
 * A shortcut in its canonical string form (`right_alt`, `f9`,
 * `ctrl+shift+space`). Rust validates it; the UI only round-trips the value.
 */
export type Hotkey = string;

/** The current shortcut plus the label Rust renders for it. */
export interface HotkeyView {
  hotkey: Hotkey;
  label: string;
}

export interface HotkeyCaptureError {
  message: string;
}

export interface Settings {
  launch_at_login: boolean;
  input_device: string | null;
  cleanup_enabled: boolean;
  keep_raw: boolean;
  theme: Theme;
  hotkey: Hotkey;
}

export interface AccountUser {
  id: string;
  email: string;
  name: string | null;
}

export interface Usage {
  words_used: number;
  /** null for Pro: the fair-use cap is never exposed. */
  words_limit: number | null;
  week_start: string | null;
  resets_at: string | null;
}

export interface Account {
  user: AccountUser;
  plan: "starter" | "pro" | string;
  interval: string | null;
  status: string | null;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  usage: Usage;
}

export interface AuthState {
  signed_in: boolean;
  account: Account | null;
}

export interface Snapshot {
  history: HistoryEntry[];
  dictionary: string[];
  settings: Settings;
  auth: AuthState;
  devices: InputDevice[];
  launch_at_login: boolean;
  hotkey_error: string | null;
  version: string;
}

/** True only inside a Tauri webview; plain-browser previews have no IPC. */
export function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Plain-browser previews (bar.html / index.html opened directly) must not
 * throw from @tauri-apps/api's callback plumbing. Resolve as a no-op instead;
 * the real app always has the internals object before any of this runs.
 */
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasTauri()) return Promise.resolve(undefined as T);
  return invoke<T>(command, args);
}

export const api = {
  snapshot: () => call<Snapshot>("get_snapshot"),
  saveSettings: (settings: Settings) =>
    call<Settings>("save_settings", { settings }),
  addDictionary: (term: string) => call<string[]>("add_dictionary", { term }),
  removeDictionary: (term: string) => call<string[]>("remove_dictionary", { term }),
  deleteHistory: (id: string) => call<void>("delete_history", { id }),
  clearHistory: () => call<void>("clear_history"),
  copyText: (text: string, mode: string | null) =>
    call<void>("copy_text", { text, mode }),
  startDictation: () => call<void>("start_dictation"),
  stopDictation: () => call<void>("stop_dictation"),
  cancelDictation: () => call<void>("cancel_dictation"),
  openMain: () => call<void>("open_main"),
  reloadConfig: () => call<void>("reload_config"),
  retryHotkey: () => call<string | null>("retry_hotkey"),
  getHotkey: () => call<HotkeyView>("get_hotkey"),
  startHotkeyCapture: () => call<void>("start_hotkey_capture"),
  cancelHotkeyCapture: () => call<void>("cancel_hotkey_capture"),
  setHotkey: (hotkey: Hotkey) => call<HotkeyView>("set_hotkey", { hotkey }),
  resetHotkey: () => call<HotkeyView>("reset_hotkey"),
  quit: () => call<void>("quit"),
  authState: () => call<AuthState>("auth_state"),
  signIn: () => call<void>("sign_in"),
  cancelSignIn: () => call<void>("cancel_sign_in"),
  signOut: () => call<AuthState>("sign_out"),
  refreshAccount: () => call<AuthState>("refresh_account"),
  openCheckout: (interval: "monthly" | "annual") =>
    call<void>("open_checkout", { interval }),
  openBillingPortal: () => call<void>("open_billing_portal"),
};

export function onEvent<T>(
  name: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!hasTauri()) return Promise.resolve(() => {});
  return listen<T>(name, (event) => handler(event.payload));
}
