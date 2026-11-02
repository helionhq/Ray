//! Commands exposed to the two webviews.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio::{self, InputDevice};
use crate::config::CleanupMode;
use crate::hotkey;
use crate::pipeline::{ConfigSummary, Dictation};
use crate::secrets;
use crate::store::{self, HistoryEntry, Settings, Store};
use crate::windows_util;

#[derive(Serialize)]
pub struct KeyStatus {
    pub assemblyai: bool,
    pub vercel: bool,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub history: Vec<HistoryEntry>,
    pub dictionary: Vec<String>,
    pub settings: Settings,
    pub keys: KeyStatus,
    pub devices: Vec<InputDevice>,
    pub config: ConfigSummary,
    pub launch_at_login: bool,
    /// `None` when the Right Alt hook is healthy.
    pub hotkey_error: Option<String>,
    pub version: String,
}

#[tauri::command]
pub async fn get_snapshot(
    store: State<'_, Arc<Store>>,
    dictation: State<'_, Arc<Dictation>>,
) -> Result<Snapshot, String> {
    let data = store.snapshot();
    let cleanup_mode = CleanupMode::from_id(&data.settings.cleanup_mode).unwrap_or_default();
    Ok(Snapshot {
        history: data.history,
        dictionary: data.dictionary,
        settings: data.settings,
        keys: KeyStatus {
            assemblyai: secrets::has(secrets::ASSEMBLYAI),
            vercel: secrets::has(secrets::VERCEL),
        },
        devices: audio::list_input_devices().unwrap_or_default(),
        config: dictation.config_summary(cleanup_mode),
        launch_at_login: windows_util::launch_at_login(),
        hotkey_error: hotkey::status(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[tauri::command]
pub fn save_secret(provider: String, value: String) -> Result<(), String> {
    validate_provider(&provider)?;
    secrets::set(&provider, &value)
}

#[tauri::command]
pub fn clear_secret(provider: String) -> Result<(), String> {
    validate_provider(&provider)?;
    secrets::delete(&provider)
}

fn validate_provider(provider: &str) -> Result<(), String> {
    match provider {
        secrets::ASSEMBLYAI | secrets::VERCEL => Ok(()),
        other => Err(format!("Unknown provider: {other}")),
    }
}

#[tauri::command]
pub async fn test_secret(
    provider: String,
    dictation: State<'_, Arc<Dictation>>,
) -> Result<String, String> {
    validate_provider(&provider)?;
    let key =
        secrets::get(&provider).ok_or_else(|| "Save a key first, then test it.".to_string())?;
    if provider == secrets::ASSEMBLYAI {
        let response = dictation
            .http()
            .get("https://api.assemblyai.com/v2/transcript?limit=1")
            .header("authorization", &key)
            .timeout(Duration::from_secs(12))
            .send()
            .await
            .map_err(|error| format!("Could not reach AssemblyAI: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "AssemblyAI rejected the key (HTTP {})",
                response.status()
            ));
        }
        // The same key powers the primary cleanup model on the LLM Gateway.
        if let Some(provider) = dictation.cleanup_provider(secrets::ASSEMBLYAI) {
            let body = json!({
                "model": provider.model,
                "messages": [{ "role": "user", "content": "Reply with OK." }],
                "temperature": 0,
                "max_tokens": 32,
                "stream": false,
            });
            let llm = dictation
                .http()
                .post(format!(
                    "{}/chat/completions",
                    provider.base_url.trim_end_matches('/')
                ))
                .header("authorization", format!("Bearer {key}"))
                .json(&body)
                .timeout(Duration::from_secs(15))
                .send()
                .await;
            return Ok(match llm {
                Ok(response) if response.status().is_success() => format!(
                    "AssemblyAI connected · speech + {}",
                    provider.model
                ),
                Ok(response) => format!(
                    "Speech connected; the LLM Gateway returned HTTP {} (cleanup will use the raw transcript)",
                    response.status()
                ),
                Err(_) => "Speech connected; the LLM Gateway was unreachable (cleanup will use the raw transcript)".into(),
            });
        }
        return Ok("AssemblyAI connected".into());
    }

    let provider_config = dictation
        .cleanup_provider(&provider)
        .ok_or_else(|| "This provider is not in pipeline.json".to_string())?;
    let mut body = json!({
        "model": provider_config.model,
        "messages": [{ "role": "user", "content": "Reply with OK." }],
        "temperature": 0,
        "max_tokens": 64,
        "stream": false,
    });
    if let (Some(extra), Some(object)) = (&provider_config.extra_body, body.as_object_mut()) {
        if let Some(extra) = extra.as_object() {
            for (key, value) in extra {
                object.insert(key.clone(), value.clone());
            }
        }
    }
    let response = dictation
        .http()
        .post(format!(
            "{}/chat/completions",
            provider_config.base_url.trim_end_matches('/')
        ))
        .header("authorization", format!("Bearer {key}"))
        .json(&body)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("Could not reach {}: {error}", provider_config.id))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(|message| message.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| text.chars().take(160).collect());
        return Err(format!(
            "{} rejected the key (HTTP {status}): {message}",
            provider_config.id
        ));
    }
    Ok(format!(
        "{} connected · {}",
        provider_config.id, provider_config.model
    ))
}

#[tauri::command]
pub fn save_settings(settings: Settings, store: State<'_, Arc<Store>>) -> Result<Settings, String> {
    let previous = windows_util::launch_at_login();
    let changed = previous != settings.launch_at_login;
    if changed {
        windows_util::set_launch_at_login(settings.launch_at_login)?;
    }
    match store.update_settings(settings) {
        Ok(saved) => Ok(saved),
        Err(error) => {
            // The store and the Run key must not disagree: put the registry
            // back, and keep the store error as the one the user sees.
            if changed {
                if let Err(rollback) = windows_util::set_launch_at_login(previous) {
                    return Err(format!(
                        "{error} (launch at login could not be restored: {rollback})"
                    ));
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub fn add_dictionary(term: String, store: State<'_, Arc<Store>>) -> Result<Vec<String>, String> {
    store.add_dictionary(&term)
}

#[tauri::command]
pub fn remove_dictionary(
    term: String,
    store: State<'_, Arc<Store>>,
) -> Result<Vec<String>, String> {
    store.remove_dictionary(&term)
}

#[tauri::command]
pub fn delete_history(
    id: String,
    store: State<'_, Arc<Store>>,
    app: AppHandle,
) -> Result<(), String> {
    store.delete_history(&id)?;
    let _ = app.emit_to("main", "state-changed", ());
    Ok(())
}

#[tauri::command]
pub fn clear_history(store: State<'_, Arc<Store>>, app: AppHandle) -> Result<(), String> {
    store.clear_history()?;
    let _ = app.emit_to("main", "state-changed", ());
    Ok(())
}

#[tauri::command]
pub fn copy_text(text: String, mode: Option<String>) -> Result<(), String> {
    let line_endings = crate::paste::line_endings_for_mode(
        mode.as_deref().and_then(CleanupMode::from_id),
    );
    crate::paste::copy_text_with(&text, line_endings)
}

/// The most recent transcript whose History save failed. It is kept in memory
/// so the text is still recoverable when History and the clipboard both miss
/// it.
#[tauri::command]
pub fn get_unsaved_text(dictation: State<'_, Arc<Dictation>>) -> Option<String> {
    dictation.unsaved_text()
}

#[tauri::command]
pub fn copy_unsaved_text(dictation: State<'_, Arc<Dictation>>) -> Result<bool, String> {
    match dictation.unsaved_text() {
        Some(text) => crate::paste::copy_text(&text).map(|()| true),
        None => Ok(false),
    }
}

/// The bar webview may finish loading after the first state event; it asks for
/// the current state on mount.
#[tauri::command]
pub fn get_bar_state(dictation: State<'_, Arc<Dictation>>) -> serde_json::Value {
    dictation.bar_payload()
}

#[tauri::command]
pub async fn start_dictation(dictation: State<'_, Arc<Dictation>>) -> Result<(), String> {
    dictation.start().await;
    Ok(())
}

#[tauri::command]
pub async fn stop_dictation(dictation: State<'_, Arc<Dictation>>) -> Result<(), String> {
    dictation.stop().await;
    Ok(())
}

#[tauri::command]
pub async fn cancel_dictation(dictation: State<'_, Arc<Dictation>>) -> Result<(), String> {
    dictation.cancel().await;
    Ok(())
}

#[tauri::command]
pub fn open_main(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn reload_config(app: AppHandle, dictation: State<'_, Arc<Dictation>>) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not find the app data folder: {error}"))?;
    dictation.reload_config(&dir);
    Ok(())
}

#[tauri::command]
pub fn retry_hotkey() -> Result<Option<String>, String> {
    hotkey::reinstall()?;
    Ok(hotkey::status())
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn copy_history_entry(id: String, store: State<'_, Arc<Store>>) -> Result<(), String> {
    let data = store.snapshot();
    let entry = data
        .history
        .iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| "That entry no longer exists".to_string())?;
    let line_endings = crate::paste::line_endings_for_mode(
        entry.mode.as_deref().and_then(CleanupMode::from_id),
    );
    crate::paste::copy_text_with(&entry.text, line_endings)
}

#[allow(dead_code)]
pub fn now() -> i64 {
    store::now_millis()
}
