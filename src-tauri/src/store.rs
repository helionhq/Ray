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
    pub streaming_enabled: bool,
    pub keep_raw: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            launch_at_login: false,
            input_device: None,
            cleanup_enabled: true,
            streaming_enabled: true,
            keep_raw: true,
        }
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
}

impl Store {
    pub fn load(app_data: &Path) -> Self {
        let path = app_data.join(FILE_NAME);
        let data = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<StoreData>(&text).unwrap_or_else(|error| {
                eprintln!("[ray] could not parse {}: {error}", path.display());
                StoreData::default()
            }),
            Err(_) => StoreData::default(),
        };
        let store = Self {
            path,
            data: Mutex::new(data),
        };
        store.normalize();
        store
    }

    fn normalize(&self) {
        let mut data = self.data.lock().unwrap();
        data.history
            .sort_by_key(|entry| std::cmp::Reverse(entry.created_at));
        data.history.truncate(MAX_HISTORY);
        let mut seen = std::collections::HashSet::new();
        data.dictionary.retain(|word| {
            let word = word.trim();
            !word.is_empty() && seen.insert(word.to_lowercase())
        });
        data.dictionary.truncate(MAX_DICTIONARY);
    }

    fn persist(&self, data: &StoreData) -> Result<(), String> {
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
        self.data.lock().unwrap().clone()
    }

    pub fn settings(&self) -> Settings {
        self.data.lock().unwrap().settings.clone()
    }

    pub fn dictionary(&self) -> Vec<String> {
        self.data.lock().unwrap().dictionary.clone()
    }

    pub fn update_settings(&self, settings: Settings) -> Result<Settings, String> {
        let mut data = self.data.lock().unwrap();
        data.settings = Settings {
            launch_at_login: settings.launch_at_login,
            input_device: settings
                .input_device
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty()),
            cleanup_enabled: settings.cleanup_enabled,
            streaming_enabled: settings.streaming_enabled,
            keep_raw: settings.keep_raw,
        };
        self.persist(&data)?;
        Ok(data.settings.clone())
    }

    pub fn add_history(&self, entry: HistoryEntry) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        data.history.insert(0, entry);
        data.history.truncate(MAX_HISTORY);
        self.persist(&data)
    }

    pub fn delete_history(&self, id: &str) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        data.history.retain(|entry| entry.id != id);
        self.persist(&data)
    }

    pub fn clear_history(&self) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        data.history.clear();
        self.persist(&data)
    }

    pub fn add_dictionary(&self, term: &str) -> Result<Vec<String>, String> {
        let term = term.trim();
        if term.is_empty() {
            return Ok(self.dictionary());
        }
        if term.chars().count() > 80 {
            return Err("Keep dictionary terms under 80 characters".into());
        }
        {
            let mut data = self.data.lock().unwrap();
            if !data
                .dictionary
                .iter()
                .any(|word| word.eq_ignore_ascii_case(term))
            {
                if data.dictionary.len() >= MAX_DICTIONARY {
                    return Err("The dictionary is full".into());
                }
                data.dictionary.push(term.to_string());
                self.persist(&data)?;
            }
        }
        Ok(self.dictionary())
    }

    pub fn remove_dictionary(&self, term: &str) -> Result<Vec<String>, String> {
        {
            let mut data = self.data.lock().unwrap();
            data.dictionary
                .retain(|word| !word.eq_ignore_ascii_case(term));
            self.persist(&data)?;
        }
        Ok(self.dictionary())
    }

    /// STT keyterms: trimmed, de-duplicated, capped.
    pub fn keyterms(&self, limit: usize) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        let mut terms = Vec::new();
        for term in self.data.lock().unwrap().dictionary.iter() {
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
