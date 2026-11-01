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

export interface Settings {
  launch_at_login: boolean;
  input_device: string | null;
  cleanup_enabled: boolean;
  streaming_enabled: boolean;
  keep_raw: boolean;
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

export const api = {
  snapshot: () => invoke<Snapshot>("get_snapshot"),
  saveSecret: (provider: Provider, value: string) =>
    invoke<void>("save_secret", { provider, value }),
  clearSecret: (provider: Provider) => invoke<void>("clear_secret", { provider }),
  testSecret: (provider: Provider) => invoke<string>("test_secret", { provider }),
  saveSettings: (settings: Settings) =>
    invoke<Settings>("save_settings", { settings }),
  addDictionary: (term: string) => invoke<string[]>("add_dictionary", { term }),
  removeDictionary: (term: string) => invoke<string[]>("remove_dictionary", { term }),
  deleteHistory: (id: string) => invoke<void>("delete_history", { id }),
  clearHistory: () => invoke<void>("clear_history"),
  copyText: (text: string) => invoke<void>("copy_text", { text }),
  startDictation: () => invoke<void>("start_dictation"),
  stopDictation: () => invoke<void>("stop_dictation"),
  cancelDictation: () => invoke<void>("cancel_dictation"),
  openMain: () => invoke<void>("open_main"),
  reloadConfig: () => invoke<void>("reload_config"),
  retryHotkey: () => invoke<string | null>("retry_hotkey"),
  quit: () => invoke<void>("quit"),
};

export function onEvent<T>(
  name: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(name, (event) => handler(event.payload));
}
