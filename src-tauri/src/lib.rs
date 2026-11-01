mod audio;
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
use tauri::{Manager, RunEvent, WindowEvent};

use crate::pipeline::Dictation;

pub use selftest::{run_mic_test, run_selftest, run_selftest_resampled};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;

            let runtime_config = config::RuntimeConfig::load(&app_data);
            let store = Arc::new(store::Store::load(&app_data));
            app.manage(store.clone());

            let dictation = Dictation::new(app.handle().clone(), store, runtime_config);
            app.manage(dictation.clone());

            // The global Right Alt hook.
            let (hotkey_tx, mut hotkey_rx) = tokio::sync::mpsc::unbounded_channel();
            if let Err(error) = hotkey::install(hotkey_tx) {
                eprintln!("[ray] {error}");
            }
            tauri::async_runtime::spawn(async move {
                while let Some(event) = hotkey_rx.recv().await {
                    match event {
                        hotkey::HotkeyEvent::Toggle => dictation.toggle().await,
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
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::save_secret,
            commands::clear_secret,
            commands::test_secret,
            commands::save_settings,
            commands::add_dictionary,
            commands::remove_dictionary,
            commands::delete_history,
            commands::clear_history,
            commands::copy_text,
            commands::copy_history_entry,
            commands::get_bar_state,
            commands::start_dictation,
            commands::stop_dictation,
            commands::cancel_dictation,
            commands::open_main,
            commands::reload_config,
            commands::quit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Ray")
        .run(|_app, event| {
            if matches!(event, RunEvent::Exit) {
                hotkey::uninstall();
            }
        });
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Ray", true, None::<&str>)?;
    let dictate = MenuItem::with_id(app, "dictate", "Start dictation", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Ray", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &dictate, &quit])?;

    let mut builder = TrayIconBuilder::with_id("ray-tray")
        .tooltip("Ray — Right Alt to dictate")
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
