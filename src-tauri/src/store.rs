//! Local, on-disk state: dictation history, the dictionary, and settings.
//!
//! A single JSON document in the app-data directory is enough at this scale,
//! keeps the build light, and is easy to inspect. Writes are atomic-ish: a
//! temporary file is written and then swapped in.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::hotkey::Hotkey;

const FILE_NAME: &str = "ray.json";
const MAX_HISTORY: usize = 1_000;
const MAX_DICTIONARY: usize = 200;

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub launch_at_login: bool,
    pub input_device: Option<String>,
    pub cleanup_enabled: bool,
    pub keep_raw: bool,
    /// "system", "light", or "dark". Old documents without this field load
    /// with the default because the struct is `#[serde(default)]`.
    pub theme: String,
    /// The dictation shortcut. Old documents without this field load as
    /// Right Alt (the historical hard-wired shortcut).
    #[serde(default)]
    pub hotkey: Hotkey,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            launch_at_login: false,
            input_device: None,
            cleanup_enabled: true,
            keep_raw: true,
            theme: "system".into(),
            hotkey: Hotkey::default(),
        }
    }
}

/// Unknown or malformed values fall back to following the OS.
fn normalize_theme(theme: &str) -> String {
    match theme.trim().to_ascii_lowercase().as_str() {
        "light" => "light".into(),
        "dark" => "dark".into(),
        _ => "system".into(),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    /// Unix milliseconds.
    pub created_at: i64,
    pub text: String,
    pub raw: Option<String>,
    pub app: Option<String>,
    pub duration_ms: u64,
    /// Cleanup mode used for this dictation, when cleanup ran. Older entries
    /// have no field and load as `None`.
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct StoreData {
    pub history: Vec<HistoryEntry>,
    pub dictionary: Vec<String>,
    pub settings: Settings,
}

pub struct Store {
    path: PathBuf,
    data: Mutex<StoreData>,
    /// Set when the existing store could not be read and could not be
    /// preserved. `persist` refuses to write until the file is dealt with, so
    /// a failed load can never overwrite history or the dictionary.
    load_error: Option<String>,
    /// Non-fatal load note the UI can surface, e.g. a corrupt store that was
    /// preserved as a backup before new writes were allowed.
    #[allow(dead_code)] // Exposed for the frontend; no caller yet.
    load_warning: Option<String>,
}

impl Store {
    pub fn load(app_data: &Path) -> Self {
        let path = app_data.join(FILE_NAME);
        let mut load_error = None;
        let mut load_warning = None;
        let data = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<StoreData>(&text) {
                Ok(data) => data,
                Err(error) => {
                    // Keep the unreadable bytes before anything can replace
                    // them. If the copy fails, writes stay blocked instead.
                    eprintln!("[ray] could not parse {}: {error}", path.display());
                    match back_up_unreadable(&path) {
                        Ok(backup) => {
                            let note = format!(
                                "Local state could not be parsed; the original was preserved at {}",
                                backup.display()
                            );
                            eprintln!("[ray] {note}");
                            load_warning = Some(note);
                        }
                        Err(backup_error) => {
                            let message = format!(
                                "Local state could not be parsed ({error}) and could not be \
                                 backed up ({backup_error}); refusing to overwrite {}",
                                path.display()
                            );
                            eprintln!("[ray] {message}");
                            load_error = Some(message);
                        }
                    }
                    StoreData::default()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // First run: there is nothing to load or preserve.
                StoreData::default()
            }
            Err(error) => {
                // The file exists but could not be read. Do not replace it
                // with defaults, since that would destroy the user's state.
                let message = format!(
                    "Local state could not be read ({}: {error}); refusing to overwrite it",
                    path.display()
                );
                eprintln!("[ray] {message}");
                load_error = Some(message);
                StoreData::default()
            }
        };
        let store = Self {
            path,
            data: Mutex::new(data),
            load_error,
            load_warning,
        };
        store.normalize();
        store
    }

    /// Why the store is refusing all writes, if it is. A non-`None` value
    /// means the on-disk file could not be loaded or preserved and every
    /// mutation will return this message without touching the file.
    #[allow(dead_code)] // Exposed for the frontend; no caller yet.
    pub fn load_error(&self) -> Option<&str> {
        self.load_error.as_deref()
    }

    /// A non-fatal note from `load`, such as a corrupt store that was backed
    /// up. The UI can show this to explain why history looks empty.
    #[allow(dead_code)] // Exposed for the frontend; no caller yet.
    pub fn load_warning(&self) -> Option<&str> {
        self.load_warning.as_deref()
    }

    fn normalize(&self) {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        data.history
            .sort_by_key(|entry| std::cmp::Reverse(entry.created_at));
        data.history.truncate(MAX_HISTORY);
        let mut seen = std::collections::HashSet::new();
        data.dictionary.retain(|word| {
            let word = word.trim();
            !word.is_empty() && seen.insert(word.to_lowercase())
        });
        data.dictionary.truncate(MAX_DICTIONARY);
        data.settings.theme = normalize_theme(&data.settings.theme);
        data.settings.hotkey = data.settings.hotkey.normalized();
    }

    fn persist(&self, data: &StoreData) -> Result<(), String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("Create app data dir: {error}"))?;
        }
        let text = serde_json::to_string_pretty(data)
            .map_err(|error| format!("Serialize local state: {error}"))?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, text).map_err(|error| format!("Write local state: {error}"))?;
        fs::rename(&tmp, &self.path).map_err(|error| format!("Save local state: {error}"))?;
        Ok(())
    }

    pub fn snapshot(&self) -> StoreData {
        self.data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn settings(&self) -> Settings {
        self.data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .settings
            .clone()
    }

    pub fn dictionary(&self) -> Vec<String> {
        self.data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .dictionary
            .clone()
    }

    pub fn update_settings(&self, settings: Settings) -> Result<Settings, String> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut candidate = data.clone();
        candidate.settings = Settings {
            launch_at_login: settings.launch_at_login,
            input_device: settings
                .input_device
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty()),
            cleanup_enabled: settings.cleanup_enabled,
            keep_raw: settings.keep_raw,
            theme: normalize_theme(&settings.theme),
            hotkey: settings.hotkey.normalized(),
        };
        self.persist(&candidate)?;
        *data = candidate;
        Ok(data.settings.clone())
    }

    /// Change only the dictation shortcut, leaving every other setting as it
    /// is on disk. Used by the Shortcut settings section so a stale copy of
    /// the rest of Settings can never clobber it.
    pub fn update_hotkey(&self, hotkey: Hotkey) -> Result<Settings, String> {
        // Read, mutate, and write under one lock so a concurrent settings
        // change can never be clobbered by a stale copy of the rest of
        // Settings. Only `hotkey` is touched.
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut candidate = data.clone();
        candidate.settings.hotkey = hotkey.normalized();
        self.persist(&candidate)?;
        *data = candidate;
        Ok(data.settings.clone())
    }

    pub fn add_history(&self, entry: HistoryEntry) -> Result<(), String> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut candidate = data.clone();
        candidate.history.insert(0, entry);
        candidate.history.truncate(MAX_HISTORY);
        self.persist(&candidate)?;
        *data = candidate;
        Ok(())
    }

    pub fn delete_history(&self, id: &str) -> Result<(), String> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut candidate = data.clone();
        candidate.history.retain(|entry| entry.id != id);
        self.persist(&candidate)?;
        *data = candidate;
        Ok(())
    }

    pub fn clear_history(&self) -> Result<(), String> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut candidate = data.clone();
        candidate.history.clear();
        self.persist(&candidate)?;
        *data = candidate;
        Ok(())
    }

    pub fn add_dictionary(&self, term: &str) -> Result<Vec<String>, String> {
        let term = term.trim();
        if term.is_empty() {
            return Ok(self.dictionary());
        }
        if term.chars().count() > 80 {
            return Err("Keep dictionary terms under 80 characters".into());
        }
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !data
            .dictionary
            .iter()
            .any(|word| word.eq_ignore_ascii_case(term))
        {
            if data.dictionary.len() >= MAX_DICTIONARY {
                return Err("The dictionary is full".into());
            }
            let mut candidate = data.clone();
            candidate.dictionary.push(term.to_string());
            self.persist(&candidate)?;
            *data = candidate;
        }
        Ok(data.dictionary.clone())
    }

    pub fn remove_dictionary(&self, term: &str) -> Result<Vec<String>, String> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut candidate = data.clone();
        let before = candidate.dictionary.len();
        candidate
            .dictionary
            .retain(|word| !word.eq_ignore_ascii_case(term));
        // Nothing matched: leave both memory and disk alone.
        if candidate.dictionary.len() != before {
            self.persist(&candidate)?;
            *data = candidate;
        }
        Ok(data.dictionary.clone())
    }

    /// STT keyterms: trimmed, de-duplicated, capped.
    pub fn keyterms(&self, limit: usize) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        let mut terms = Vec::new();
        for term in self
            .data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .dictionary
            .iter()
        {
            let term = term.trim();
            if term.is_empty() || term.chars().count() > 50 {
                continue;
            }
            if seen.insert(term.to_lowercase()) {
                terms.push(term.to_string());
            }
            if terms.len() >= limit {
                break;
            }
        }
        terms
    }
}

/// Copy a store that failed to parse next to the original, so the first new
/// write cannot destroy it, and return where it was preserved.
fn back_up_unreadable(path: &Path) -> Result<PathBuf, String> {
    let millis = now_millis();
    let mut backup = path.with_file_name(format!("{FILE_NAME}.corrupt-{millis}"));
    let mut suffix = 1;
    while backup.exists() {
        backup = path.with_file_name(format!("{FILE_NAME}.corrupt-{millis}-{suffix}"));
        suffix += 1;
    }
    fs::copy(path, &backup).map_err(|error| error.to_string())?;
    Ok(backup)
}

pub fn new_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{millis}-{n}")
}

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> Store {
        let dir = std::env::temp_dir().join(format!("ray-store-test-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        Store::load(&dir)
    }

    #[test]
    fn old_settings_documents_default_the_theme_to_system() {
        // Fields from the previous release (the streaming toggle and the
        // cleanup mode selector) must not stop an old document from loading.
        let settings: Settings = serde_json::from_str(
            r#"{"keep_raw":false,"streaming_enabled":false,"cleanup_mode":"structured"}"#,
        )
        .unwrap();
        assert_eq!(settings.theme, "system");
        assert!(!settings.keep_raw);
        assert!(settings.cleanup_enabled);
    }

    #[test]
    fn an_old_settings_file_loads_and_is_rewritten_without_retired_fields() {
        let dir = std::env::temp_dir().join(format!("ray-store-test-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(FILE_NAME),
            r#"{"settings":{"cleanup_mode":"structured","streaming_enabled":false,
                "keep_raw":false,"theme":"dark","input_device":"mic-1"}}"#,
        )
        .unwrap();
        let store = Store::load(&dir);
        let settings = store.settings();
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.input_device.as_deref(), Some("mic-1"));
        assert!(!settings.keep_raw);
        assert!(settings.cleanup_enabled);

        // Saving persists the new shape; the retired keys are gone.
        store.update_settings(settings).unwrap();
        let text = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        assert!(!text.contains("cleanup_mode"));
        assert!(!text.contains("streaming_enabled"));
        assert!(text.contains("\"keep_raw\": false"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn history_entries_written_before_modes_load_without_one() {
        let entry: HistoryEntry = serde_json::from_str(
            r#"{"id":"a","created_at":1,"text":"hi","raw":null,"app":null,"duration_ms":10}"#,
        )
        .unwrap();
        assert_eq!(entry.mode, None);
    }

    #[test]
    fn theme_is_normalized_when_saved() {
        let store = temp_store();
        let saved = store
            .update_settings(Settings {
                theme: " Dark ".into(),
                ..Settings::default()
            })
            .unwrap();
        assert_eq!(saved.theme, "dark");
        assert_eq!(store.settings().theme, "dark");

        let saved = store
            .update_settings(Settings {
                theme: "solarized".into(),
                ..Settings::default()
            })
            .unwrap();
        assert_eq!(saved.theme, "system");
    }

    #[test]
    fn old_settings_documents_default_the_hotkey_to_right_alt() {
        let settings: Settings =
            serde_json::from_str(r#"{"keep_raw":false,"streaming_enabled":false}"#).unwrap();
        assert_eq!(settings.hotkey, Hotkey::default());
    }

    #[test]
    fn hotkey_updates_survive_a_reload() {
        let dir = std::env::temp_dir().join(format!("ray-store-test-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::load(&dir);
        store
            .update_hotkey(Hotkey::parse("ctrl+shift+space").unwrap())
            .unwrap();

        let reloaded = Store::load(&dir);
        assert_eq!(
            reloaded.settings().hotkey,
            Hotkey::parse("ctrl+shift+space").unwrap()
        );
        // The targeted update must not disturb other settings.
        assert!(reloaded.settings().keep_raw);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_hand_edited_unknown_hotkey_loads_as_right_alt() {
        let dir = std::env::temp_dir().join(format!("ray-store-test-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), r#"{"settings":{"hotkey":"banana"}}"#).unwrap();
        let store = Store::load(&dir);
        assert_eq!(store.settings().hotkey, Hotkey::default());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn non_string_hotkey_values_load_as_right_alt_without_losing_state() {
        for value in ["null", "5"] {
            let dir = std::env::temp_dir().join(format!("ray-store-test-{}", new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join(FILE_NAME),
                format!(
                    r#"{{"history":[{{"id":"a","created_at":1,"text":"hi","raw":null,
                        "app":null,"duration_ms":10}}],
                        "dictionary":["Helion"],
                        "settings":{{"hotkey":{value}}}}}"#
                ),
            )
            .unwrap();
            let store = Store::load(&dir);
            assert!(
                store.load_error().is_none(),
                "{value}: {:?}",
                store.load_error()
            );
            assert!(
                store.load_warning().is_none(),
                "{value}: {:?}",
                store.load_warning()
            );
            assert_eq!(store.settings().hotkey, Hotkey::default());
            // A single bad field must not cost the user their state.
            assert_eq!(store.snapshot().history.len(), 1);
            assert_eq!(store.dictionary(), vec!["Helion".to_string()]);
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[test]
    fn update_hotkey_only_touches_the_hotkey() {
        let store = temp_store();
        // Stand in for another writer that changed settings in memory. The
        // old split read-modify-write funnelled this through update_settings,
        // which rewrote (and normalized) every field from a stale snapshot.
        store.data.lock().unwrap().settings.input_device = Some("  mic  ".into());
        store.update_hotkey(Hotkey::parse("f9").unwrap()).unwrap();

        assert_eq!(store.settings().hotkey, Hotkey::parse("f9").unwrap());
        assert_eq!(store.settings().input_device.as_deref(), Some("  mic  "));

        let saved: StoreData =
            serde_json::from_str(&std::fs::read_to_string(&store.path).unwrap()).unwrap();
        assert_eq!(saved.settings.input_device.as_deref(), Some("  mic  "));
        std::fs::remove_dir_all(store.path.parent().unwrap()).ok();
    }

    #[test]
    fn a_hand_edited_unknown_theme_loads_as_system() {
        let dir = std::env::temp_dir().join(format!("ray-store-test-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), r#"{"settings":{"theme":"solarized"}}"#).unwrap();
        let store = Store::load(&dir);
        assert_eq!(store.settings().theme, "system");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn failed_persist_leaves_memory_and_disk_state_unchanged() {
        // The store's parent path is an existing *file*, so create_dir_all /
        // write always fail. A mutation must not reach memory when the write
        // did not happen.
        let dir = std::env::temp_dir().join(format!("ray-store-test-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let blocker = dir.join("not-a-directory");
        std::fs::write(&blocker, b"blocker").unwrap();
        let store = Store::load(&blocker);

        let entry = HistoryEntry {
            id: "a".into(),
            created_at: 1,
            text: "text".into(),
            raw: None,
            app: None,
            duration_ms: 10,
            mode: None,
        };
        assert!(store.add_history(entry).is_err());
        assert!(store.snapshot().history.is_empty());

        let settings = Settings {
            launch_at_login: true,
            ..Settings::default()
        };
        assert!(store.update_settings(settings).is_err());
        assert!(!store.settings().launch_at_login);

        assert!(store.add_dictionary("Helion").is_err());
        assert!(store.dictionary().is_empty());
        assert!(store.delete_history("a").is_err());
        assert!(store.clear_history().is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_store_loads_defaults_and_allows_writes() {
        let store = temp_store();
        assert!(store.load_error().is_none());
        assert!(store.load_warning().is_none());
        store.add_dictionary("Helion").unwrap();
        assert_eq!(store.dictionary(), vec!["Helion".to_string()]);
    }

    #[test]
    fn a_corrupt_store_is_backed_up_before_writes_replace_it() {
        let dir = std::env::temp_dir().join(format!("ray-store-test-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Truncated JSON: the read succeeds but parsing does not.
        let original =
            r#"{"history":[{"id":"keep-me","created_at":1,"text":"old","dictionary":["Helion"#;
        std::fs::write(dir.join(FILE_NAME), original).unwrap();

        let store = Store::load(&dir);
        assert!(store.load_error().is_none());
        let warning = store
            .load_warning()
            .expect("a corrupt store should be reported");
        assert!(warning.contains("preserved"), "warning was: {warning}");

        let backup = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("ray.json.corrupt-"))
            })
            .expect("the unreadable store was copied aside");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);

        // The original is safe, so new writes may proceed.
        store.add_dictionary("Kubernetes").unwrap();
        assert_eq!(store.dictionary(), vec!["Kubernetes".to_string()]);
        let saved: StoreData =
            serde_json::from_str(&std::fs::read_to_string(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(saved.dictionary, vec!["Kubernetes".to_string()]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_store_blocks_writes_and_is_left_in_place() {
        let dir = std::env::temp_dir().join(format!("ray-store-test-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A directory cannot be read as a file (and is not NotFound), which
        // simulates a store that exists but cannot be loaded.
        let path = dir.join(FILE_NAME);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("sentinel"), b"keep").unwrap();

        let store = Store::load(&dir);
        let error = store
            .load_error()
            .expect("an unreadable store must block writes");
        assert!(
            error.contains("refusing to overwrite"),
            "error was: {error}"
        );
        assert!(store.load_warning().is_none());

        let entry = HistoryEntry {
            id: "a".into(),
            created_at: 1,
            text: "text".into(),
            raw: None,
            app: None,
            duration_ms: 10,
            mode: None,
        };
        assert!(store.add_history(entry).is_err());
        assert!(store.add_dictionary("Helion").is_err());
        assert!(store.update_settings(Settings::default()).is_err());

        // The unreadable original and its contents are untouched.
        assert!(path.is_dir());
        assert!(path.join("sentinel").exists());
        assert!(!dir.join("ray.json.tmp").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dictionary_is_case_insensitively_deduplicated() {
        let store = temp_store();
        store.add_dictionary("Helion HQ").unwrap();
        store.add_dictionary("helion hq").unwrap();
        store.add_dictionary("  Kubernetes ").unwrap();
        assert_eq!(
            store.dictionary(),
            vec!["Helion HQ".to_string(), "Kubernetes".to_string()]
        );
        store.remove_dictionary("HELION HQ").unwrap();
        assert_eq!(store.dictionary(), vec!["Kubernetes".to_string()]);
    }

    #[test]
    fn history_is_newest_first_and_deletable() {
        let store = temp_store();
        let entry = |id: &str, at: i64| HistoryEntry {
            id: id.into(),
            created_at: at,
            text: format!("text {id}"),
            raw: None,
            app: Some("Notepad".into()),
            duration_ms: 1000,
            mode: None,
        };
        store.add_history(entry("a", 1)).unwrap();
        store.add_history(entry("b", 2)).unwrap();
        let history = store.snapshot().history;
        assert_eq!(history[0].id, "b");
        store.delete_history("b").unwrap();
        assert_eq!(store.snapshot().history.len(), 1);
        store.clear_history().unwrap();
        assert!(store.snapshot().history.is_empty());
    }

    #[test]
    fn keyterms_are_capped_and_trimmed() {
        let store = temp_store();
        store.add_dictionary("Ray").unwrap();
        store.add_dictionary("Helion").unwrap();
        assert_eq!(store.keyterms(1), vec!["Ray".to_string()]);
    }
}
