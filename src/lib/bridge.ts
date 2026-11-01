import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface HistoryEntry {
  id: string;
  created_at: number;
  text: string;
  raw: string | null;
  app: string | null;
  duration_ms: number;
}

export interface InputDevice {
  id: string;
  name: string;
  is_default: boolean;
}

export type Theme = "system" | "light" | "dark";

export interface Settings {
  launch_at_login: boolean;
  input_device: string | null;
  cleanup_enabled: boolean;
  streaming_enabled: boolean;
  keep_raw: boolean;
  theme: Theme;
}

export interface KeyStatus {
  assemblyai: boolean;
  groq: boolean;
  vercel: boolean;
}

export interface ConfigSummary {
  pipeline_source: string;
  prompt_source: string;
  speech_model: string;
  streaming: boolean;
  cleanup_models: string[];
}

export interface Snapshot {
  history: HistoryEntry[];
  dictionary: string[];
  settings: Settings;
  keys: KeyStatus;
  devices: InputDevice[];
  config: ConfigSummary;
  launch_at_login: boolean;
  hotkey_error: string | null;
  version: string;
}

export type Provider = "assemblyai" | "groq" | "vercel";

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
  saveSecret: (provider: Provider, value: string) =>
    call<void>("save_secret", { provider, value }),
  clearSecret: (provider: Provider) => call<void>("clear_secret", { provider }),
  testSecret: (provider: Provider) => call<string>("test_secret", { provider }),
  saveSettings: (settings: Settings) =>
    call<Settings>("save_settings", { settings }),
  setTitleBarDark: (dark: boolean) =>
    call<void>("set_title_bar_dark", { dark }),
  addDictionary: (term: string) => call<string[]>("add_dictionary", { term }),
  removeDictionary: (term: string) => call<string[]>("remove_dictionary", { term }),
  deleteHistory: (id: string) => call<void>("delete_history", { id }),
  clearHistory: () => call<void>("clear_history"),
  copyText: (text: string) => call<void>("copy_text", { text }),
  startDictation: () => call<void>("start_dictation"),
  stopDictation: () => call<void>("stop_dictation"),
  cancelDictation: () => call<void>("cancel_dictation"),
  openMain: () => call<void>("open_main"),
  reloadConfig: () => call<void>("reload_config"),
  retryHotkey: () => call<string | null>("retry_hotkey"),
  quit: () => call<void>("quit"),
};

export function onEvent<T>(
  name: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!hasTauri()) return Promise.resolve(() => {});
  return listen<T>(name, (event) => handler(event.payload));
}
