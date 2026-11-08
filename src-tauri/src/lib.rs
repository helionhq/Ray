mod api;
mod audio;
mod auth;
mod cleanup;
mod commands;
mod config;
mod hotkey;
mod paste;
mod pipeline;
mod secrets;
mod selftest;
mod store;
mod stt;
mod windows_util;

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::auth::Auth;
use crate::pipeline::Dictation;

pub use selftest::{run_mic_test, run_selftest, run_selftest_resampled};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;

            let runtime_config = config::RuntimeConfig::load(&app_data);
            let store = Arc::new(store::Store::load(&app_data));
            app.manage(store.clone());

            // Remove credentials for providers Ray no longer ships. Idempotent
            // and error-tolerant so old installs start cleanly.
            secrets::remove_retired_secrets();

            let auth = Arc::new(Auth::load());
            app.manage(auth.clone());

            let dictation = Dictation::new(app.handle().clone(), store, auth, runtime_config);
            app.manage(dictation.clone());

            // Installed builds register `ray://` at install time from
            // tauri.conf.json; debug builds must register it at runtime so the
            // browser hand-off works with `tauri dev`.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                if let Err(error) = app.deep_link().register_all() {
                    eprintln!("[ray] could not register the ray:// scheme: {error}");
                }
            }
            let deep_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                handle_deep_links(&deep_handle, event.urls());
            });
            // An app launched by the browser carries the URL in its command
            // line; the event may have fired before this listener existed.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                handle_deep_links(app.handle(), urls);
            }

            // The global Right Alt hook.
            let (hotkey_tx, mut hotkey_rx) = tokio::sync::mpsc::unbounded_channel();
            if let Err(error) = hotkey::install(hotkey_tx) {
                eprintln!("[ray] {error}");
            }
            tauri::async_runtime::spawn(async move {
                while let Some(event) = hotkey_rx.recv().await {
                    match event {
                        hotkey::HotkeyEvent::Toggle(at) => {
                            // A press made while the previous dictation was
                            // still being transcribed must not start recording
                            // again once that finishes.
                            if !dictation.should_ignore_toggle(at) {
                                dictation.toggle().await;
                            }
                        }
                        hotkey::HotkeyEvent::Cancel => dictation.cancel().await,
                    }
                }
            });

            if let Some(bar) = app.get_webview_window("bar") {
                let _ = bar.set_ignore_cursor_events(true);
                let _ = bar.set_skip_taskbar(true);
                let _ = bar.set_always_on_top(true);
                if let Ok(hwnd) = bar.hwnd() {
                    let _ = windows_util::style_bar(hwnd);
                }
            }

            // Launched by the Run key: stay in the tray until asked for.
            if std::env::args().any(|arg| arg == "--autostart") {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.hide();
                }
            }

            setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::Focused(true) = event {
                    // Notices that arrived while the window was in the tray
                    // waited for it to be opened; show them now.
                    let dictation = window
                        .app_handle()
                        .state::<Arc<Dictation>>()
                        .inner()
                        .clone();
                    dictation.deliver_notice();
                }
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::save_settings,
            commands::add_dictionary,
            commands::remove_dictionary,
            commands::delete_history,
            commands::clear_history,
            commands::copy_text,
            commands::get_unsaved_text,
            commands::copy_unsaved_text,
            commands::copy_history_entry,
            commands::get_bar_state,
            commands::start_dictation,
            commands::stop_dictation,
            commands::cancel_dictation,
            commands::open_main,
            commands::reload_config,
            commands::retry_hotkey,
            commands::quit,
            auth::auth_state,
            auth::sign_in,
            auth::cancel_sign_in,
            auth::sign_out,
            auth::refresh_account,
            auth::open_checkout,
            auth::open_billing_portal,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Ray")
        .run(|_app, event| {
            if matches!(event, RunEvent::Exit) {
                hotkey::uninstall();
                // Put the user's clipboard back before the process goes away.
                paste::flush_pending_restore();
            }
        });
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Ray", true, None::<&str>)?;
    let dictate = MenuItem::with_id(
        app,
        "dictate",
        "Start or stop dictation",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Ray", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &dictate, &quit])?;

    let mut builder = TrayIconBuilder::with_id("ray-tray")
        .tooltip("Ray · Right Alt to dictate")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "dictate" => {
                let dictation = app.state::<Arc<Dictation>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    dictation.toggle().await;
                });
            }
            "quit" => {
                hotkey::uninstall();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Handle `ray://auth/callback` and `ray://billing/success` on the Rust side.
/// The main window gets `account-changed` (success) or `auth-error` (a bad or
/// expired hand-off) so it can leave the "waiting for your browser" state.
fn handle_deep_links(app: &tauri::AppHandle, urls: Vec<url::Url>) {
    let Some(dictation) = app
        .try_state::<Arc<Dictation>>()
        .map(|state| state.inner().clone())
    else {
        return;
    };
    let Some(auth) = app
        .try_state::<Arc<Auth>>()
        .map(|state| state.inner().clone())
    else {
        return;
    };
    let http = dictation.http().clone();
    let api_base = dictation.api_base();
    for url in urls {
        let raw = url.to_string();
        let app = app.clone();
        let auth = auth.clone();
        let http = http.clone();
        let api_base = api_base.clone();
        tauri::async_runtime::spawn(async move {
            match auth::handle_deep_link(&auth, &http, &api_base, &raw).await {
                Ok(auth::DeepLinkOutcome::Changed(state)) => {
                    let _ = app.emit("account-changed", *state);
                    show_main(&app);
                }
                Ok(auth::DeepLinkOutcome::Ignored) => {}
                Err(error) => {
                    eprintln!("[ray] sign-in failed: {error}");
                    let _ = app.emit_to("main", "auth-error", error);
                    show_main(&app);
                }
            }
        });
    }
}
