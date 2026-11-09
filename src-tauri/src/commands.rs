//! Commands exposed to the two webviews.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio::{self, InputDevice};
use crate::auth::{Auth, AuthState};
use crate::hotkey::{self, Hotkey, HotkeyView};
use crate::pipeline::Dictation;
use crate::store::{self, HistoryEntry, Settings, Store};
use crate::windows_util;

#[derive(Serialize)]
pub struct Snapshot {
    pub history: Vec<HistoryEntry>,
    pub dictionary: Vec<String>,
    pub settings: Settings,
    /// The cached sign-in and account state; refreshed from `/api/me`.
    pub auth: AuthState,
    pub devices: Vec<InputDevice>,
    pub launch_at_login: bool,
    /// `None` when the dictation-shortcut hook is healthy.
    pub hotkey_error: Option<String>,
    pub version: String,
}

#[tauri::command]
pub async fn get_snapshot(
    store: State<'_, Arc<Store>>,
    auth: State<'_, Arc<Auth>>,
) -> Result<Snapshot, String> {
    let data = store.snapshot();
    Ok(Snapshot {
        history: data.history,
        dictionary: data.dictionary,
        settings: data.settings,
        auth: auth.state(),
        devices: audio::list_input_devices().unwrap_or_default(),
        launch_at_login: windows_util::launch_at_login(),
        hotkey_error: hotkey::status(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[tauri::command]
pub fn save_settings(
    mut settings: Settings,
    store: State<'_, Arc<Store>>,
) -> Result<Settings, String> {
    // The shortcut has dedicated commands; a whole-settings round-trip must
    // never reset it (older frontends do not send the field at all).
    settings.hotkey = store.settings().hotkey;
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
    let line_endings = crate::paste::line_endings_for_mode(mode.as_deref());
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
pub fn get_hotkey(store: State<'_, Arc<Store>>) -> HotkeyView {
    HotkeyView::new(store.settings().hotkey)
}

#[tauri::command]
pub fn start_hotkey_capture() -> Result<(), String> {
    hotkey::start_capture()
}

#[tauri::command]
pub fn cancel_hotkey_capture() {
    hotkey::cancel_capture();
}

#[tauri::command]
pub fn set_hotkey(
    hotkey: String,
    store: State<'_, Arc<Store>>,
    app: AppHandle,
) -> Result<HotkeyView, String> {
    let hotkey = Hotkey::parse(&hotkey)?;
    let saved = store.update_hotkey(hotkey)?;
    apply_hotkey(&app, saved.hotkey)
}

#[tauri::command]
pub fn reset_hotkey(store: State<'_, Arc<Store>>, app: AppHandle) -> Result<HotkeyView, String> {
    let saved = store.update_hotkey(Hotkey::default())?;
    apply_hotkey(&app, saved.hotkey)
}

/// Apply a persisted shortcut to the running hook and tell the UI. The tray
/// tooltip names the shortcut, so it is refreshed at the same time.
fn apply_hotkey(app: &AppHandle, hotkey: Hotkey) -> Result<HotkeyView, String> {
    hotkey::set_hotkey(hotkey.clone());
    let view = HotkeyView::new(hotkey);
    if let Some(tray) = app.tray_by_id("ray-tray") {
        let _ = tray.set_tooltip(Some(format!("Ray · {} to dictate", view.label)));
    }
    let _ = app.emit_to("main", "hotkey-changed", view.clone());
    Ok(view)
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
    let line_endings = crate::paste::line_endings_for_mode(entry.mode.as_deref());
    crate::paste::copy_text_with(&entry.text, line_endings)
}

#[allow(dead_code)]
pub fn now() -> i64 {
    store::now_millis()
}
