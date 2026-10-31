//! The dictation state machine: hotkey → record → transcribe → clean → paste.
//!
//! One session is active at a time. `transition` serializes start/stop/cancel
//! so rapid hotkey presses cannot overlap; `recording`/`processing` are cheap
//! atomics for the hook and the bar.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::{self, Capture};
use crate::cleanup;
use crate::config::RuntimeConfig;
use crate::hotkey;
use crate::paste;
use crate::secrets;
use crate::store::{self, HistoryEntry, Store};
use crate::stt::{self, LiveSession};
use crate::windows_util;

#[derive(Clone, Debug, serde::Serialize)]
pub struct ConfigSummary {
    pub pipeline_source: String,
    pub prompt_source: String,
    pub speech_model: String,
    pub streaming: bool,
    pub cleanup_models: Vec<String>,
}

struct Session {
    capture: Capture,
    stream: Option<LiveSession>,
    started: Instant,
    target: Option<windows_util::Foreground>,
    keyterms: Vec<String>,
    cleanup_enabled: bool,
    level_task: tokio::task::JoinHandle<()>,
}

pub struct Dictation {
    app: AppHandle,
    store: Arc<Store>,
    config: RwLock<RuntimeConfig>,
    http: reqwest::Client,
    session: tokio::sync::Mutex<Option<Session>>,
    transition: tokio::sync::Mutex<()>,
    recording: Arc<AtomicBool>,
    processing: AtomicBool,
    bar_styled: AtomicBool,
    bar_payload: std::sync::Mutex<serde_json::Value>,
}

impl Dictation {
    pub fn new(app: AppHandle, store: Arc<Store>, config: RuntimeConfig) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .user_agent("Ray/0.1 (Windows)")
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Arc::new(Self {
            app,
            store,
            config: RwLock::new(config),
            http,
            session: tokio::sync::Mutex::new(None),
            transition: tokio::sync::Mutex::new(()),
            recording: Arc::new(AtomicBool::new(false)),
            processing: AtomicBool::new(false),
            bar_styled: AtomicBool::new(false),
            bar_payload: std::sync::Mutex::new(json!({ "phase": "hidden" })),
        })
    }

    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::SeqCst)
    }

    pub fn is_processing(&self) -> bool {
        self.processing.load(Ordering::SeqCst)
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub fn cleanup_provider(&self, secret_name: &str) -> Option<crate::config::CleanupProvider> {
        let config = self
            .config
            .read()
            .unwrap_or_else(|error| error.into_inner());
        config
            .pipeline
            .cleanup
            .providers
            .iter()
            .find(|provider| provider.api_key_secret == secret_name)
            .cloned()
    }

    pub fn config_summary(&self) -> ConfigSummary {
        let config = self
            .config
            .read()
            .unwrap_or_else(|error| error.into_inner());
        let speech_model = if config.pipeline.stt.mode.eq_ignore_ascii_case("sync_live") {
            config.pipeline.stt.sync_live.model.clone()
        } else {
            config.pipeline.stt.speech_model.clone()
        };
        ConfigSummary {
            pipeline_source: config.pipeline_source.clone(),
            prompt_source: config.prompt_source.clone(),
            speech_model,
            streaming: config.pipeline.stt.streaming,
            cleanup_models: config
                .pipeline
                .cleanup
                .providers
                .iter()
                .map(|provider| format!("{} ({})", provider.model, provider.id))
                .collect(),
        }
    }

    pub fn reload_config(&self, app_data: &Path) {
        let config = RuntimeConfig::load(app_data);
        *self
            .config
            .write()
            .unwrap_or_else(|error| error.into_inner()) = config;
    }

    pub async fn toggle(self: &Arc<Self>) {
        if self.is_recording() {
            self.stop().await;
        } else if !self.is_processing() {
            self.start().await;
        }
    }

    pub async fn start(self: &Arc<Self>) {
        let _transition = self.transition.lock().await;
        if self.is_recording() || self.is_processing() {
            return;
        }
        let Some(api_key) = secrets::get(secrets::ASSEMBLYAI) else {
            self.open_settings("Add your AssemblyAI key in Settings to start dictating.");
            self.fail("Add your AssemblyAI key in Settings").await;
            return;
        };

        let settings = self.store.settings();
        let pipeline = {
            let config = self
                .config
                .read()
                .unwrap_or_else(|error| error.into_inner());
            config.pipeline.clone()
        };
        // The user's dictionary comes first, then the built-in product and
        // teammate names, deduplicated and capped.
        let mut keyterms = self.store.keyterms(pipeline.stt.keyterms_limit);
        for name in &pipeline.known_names {
            if keyterms.len() >= pipeline.stt.keyterms_limit {
                break;
            }
            if !keyterms.iter().any(|term| term.eq_ignore_ascii_case(name)) {
                keyterms.push(name.clone());
            }
        }
        let target = windows_util::foreground();

        // Show the bar before the microphone opens; it should feel instant.
        self.emit_bar(json!({ "phase": "recording" }));
        self.show_bar();
        self.recording.store(true, Ordering::SeqCst);
        hotkey::set_capturing(true);

        let stream = if settings.streaming_enabled && pipeline.stt.streaming {
            Some(stt::spawn_live(
                api_key,
                pipeline.stt.clone(),
                keyterms.clone(),
                self.http.clone(),
            ))
        } else {
            None
        };
        let (dummy_tx, dummy_rx) = tokio::sync::mpsc::unbounded_channel();
        drop(dummy_rx);
        let audio_tx = stream
            .as_ref()
            .map(LiveSession::audio_sender)
            .unwrap_or(dummy_tx);
        let device = settings.input_device.clone();
        let started = Instant::now();

        let capture =
            match tokio::task::spawn_blocking(move || audio::start(device, audio_tx)).await {
                Ok(Ok(capture)) => capture,
                Ok(Err(error)) => {
                    if let Some(stream) = stream {
                        stream.abort();
                    }
                    self.recording.store(false, Ordering::SeqCst);
                    hotkey::set_capturing(false);
                    self.fail(&format!("Microphone unavailable: {error}")).await;
                    return;
                }
                Err(error) => {
                    if let Some(stream) = stream {
                        stream.abort();
                    }
                    self.recording.store(false, Ordering::SeqCst);
                    hotkey::set_capturing(false);
                    self.fail(&format!("Microphone task failed: {error}")).await;
                    return;
                }
            };

        let level = capture.level_handle();
        let recording = self.recording.clone();
        let app = self.app.clone();
        let level_task = tokio::spawn(async move {
            while recording.load(Ordering::SeqCst) {
                let value = f32::from_bits(level.load(Ordering::Relaxed));
                let _ = app.emit_to("bar", "bar-level", value);
                tokio::time::sleep(Duration::from_millis(33)).await;
            }
        });

        *self.session.lock().await = Some(Session {
            capture,
            stream,
            started,
            target,
            keyterms,
            cleanup_enabled: settings.cleanup_enabled,
            level_task,
        });
    }

    pub async fn stop(self: &Arc<Self>) {
        let _transition = self.transition.lock().await;
        if !self.is_recording() {
            return;
        }
        self.recording.store(false, Ordering::SeqCst);
        hotkey::set_capturing(false);
        self.processing.store(true, Ordering::SeqCst);
        self.emit_bar(json!({ "phase": "processing" }));

        let Some(session) = self.session.lock().await.take() else {
            self.processing.store(false, Ordering::SeqCst);
            return;
        };
        let Session {
            mut capture,
            stream,
            started,
            target,
            keyterms,
            cleanup_enabled,
            level_task,
        } = session;
        level_task.abort();
        let duration_ms = started.elapsed().as_millis() as u64;
        let audio_error = capture.error();
        let samples = tokio::task::spawn_blocking(move || capture.stop())
            .await
            .unwrap_or_default();

        if samples.len() < 1_600 {
            let message = audio_error.unwrap_or_else(|| "Didn't catch that. Try again.".into());
            self.fail(&message).await;
            return;
        }

        let (pipeline, cleanup_prompt) = {
            let config = self
                .config
                .read()
                .unwrap_or_else(|error| error.into_inner());
            (config.pipeline.clone(), config.prompt.clone())
        };
        let wav = stt::wav_from_pcm16(&samples, audio::TARGET_RATE);
        let mut raw: Option<String> = None;

        if let Some(stream) = stream {
            let too_long = pipeline.stt.mode.eq_ignore_ascii_case("sync_live")
                && started.elapsed().as_secs()
                    >= pipeline.stt.sync_live.max_audio_seconds.saturating_sub(3);
            if too_long {
                eprintln!("[ray] recording exceeded the Sync live limit; using batch");
                stream.abort();
            } else {
                let timeout = if pipeline.stt.mode.eq_ignore_ascii_case("sync_live") {
                    Duration::from_millis(pipeline.stt.force_endpoint_timeout_ms + 5_000)
                } else {
                    Duration::from_millis(
                        pipeline.stt.force_endpoint_timeout_ms
                            + pipeline.stt.terminate_timeout_ms
                            + 3_000,
                    )
                };
                match stream.finish(timeout).await {
                    Ok(text) if !text.trim().is_empty() => raw = Some(text.trim().to_string()),
                    Ok(_) => eprintln!("[ray] streaming returned no text; trying batch"),
                    Err(error) => eprintln!("[ray] streaming failed; trying batch: {error}"),
                }
            }
        }

        if raw.is_none() {
            if let Some(api_key) = secrets::get(secrets::ASSEMBLYAI) {
                let http = self.http.clone();
                let stt_config = pipeline.stt.clone();
                let terms = keyterms.clone();
                let timeout = Duration::from_millis(pipeline.stt.batch.timeout_ms + 15_000);
                match tokio::time::timeout(
                    timeout,
                    stt::transcribe_wav(&http, &api_key, &terms, wav, &stt_config),
                )
                .await
                {
                    Ok(Ok(text)) if !text.trim().is_empty() => raw = Some(text.trim().to_string()),
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => eprintln!("[ray] batch transcription failed: {error}"),
                    Err(_) => eprintln!("[ray] batch transcription timed out"),
                }
            }
        }

        let Some(raw_text) = raw else {
            self.fail("Transcription failed. Check your connection and AssemblyAI key.")
                .await;
            return;
        };

        let settings = self.store.settings();
        let mut text = raw_text.clone();
        let mut note: Option<String> = None;
        if cleanup_enabled && pipeline.cleanup.enabled {
            let dictionary = self.store.dictionary();
            let app_name = target
                .as_ref()
                .and_then(|target| target.app.clone())
                .unwrap_or_else(|| "Unknown app".into());
            let timeout = Duration::from_millis(pipeline.cleanup.timeout_ms + 6_000);
            match tokio::time::timeout(
                timeout,
                cleanup::cleanup(
                    &self.http,
                    &pipeline.cleanup,
                    &cleanup_prompt,
                    &raw_text,
                    &dictionary,
                    &pipeline.known_names,
                    &app_name,
                ),
            )
            .await
            {
                Ok(result) => {
                    text = result.text;
                    note = result.note;
                }
                Err(_) => {
                    note = Some("Cleanup timed out; pasted the raw transcript".into());
                }
            }
        }

        let raw_for_history =
            (settings.keep_raw && text.trim() != raw_text.trim()).then(|| raw_text.clone());
        let entry = HistoryEntry {
            id: store::new_id(),
            created_at: store::now_millis(),
            text: text.clone(),
            raw: raw_for_history,
            app: target.as_ref().and_then(|target| target.app.clone()),
            duration_ms,
        };
        if let Err(error) = self.store.add_history(entry) {
            eprintln!("[ray] could not save history: {error}");
        }
        let _ = self.app.emit_to("main", "state-changed", ());
        if let Some(note) = note {
            eprintln!("[ray] {note}");
        }

        let pasted = {
            let text = text.clone();
            tokio::task::spawn_blocking(move || paste::paste_text(&text)).await
        };
        if let Ok(Err(error)) = pasted {
            let _ = paste::copy_text(&text);
            self.notify_main(format!(
                "Couldn't paste automatically ({error}). The text is copied to your clipboard and saved in History."
            ));
        }

        self.emit_bar(json!({ "phase": "done" }));
        tokio::time::sleep(Duration::from_millis(520)).await;
        self.hide_bar();
        self.processing.store(false, Ordering::SeqCst);
    }

    pub async fn cancel(self: &Arc<Self>) {
        let _transition = self.transition.lock().await;
        if !self.is_recording() {
            return;
        }
        self.recording.store(false, Ordering::SeqCst);
        hotkey::set_capturing(false);
        let session = self.session.lock().await.take();
        if let Some(session) = session {
            session.level_task.abort();
            if let Some(stream) = session.stream {
                stream.abort();
            }
            let mut capture = session.capture;
            let _ = tokio::task::spawn_blocking(move || capture.stop()).await;
        }
        self.hide_bar();
        self.processing.store(false, Ordering::SeqCst);
    }

    async fn fail(&self, message: &str) {
        self.emit_bar(json!({ "phase": "error", "message": message }));
        self.show_bar();
        self.notify_main(message.to_string());
        tokio::time::sleep(Duration::from_millis(1_600)).await;
        self.hide_bar();
        self.processing.store(false, Ordering::SeqCst);
        self.recording.store(false, Ordering::SeqCst);
    }

    fn open_settings(&self, message: &str) {
        self.notify_main(message.to_string());
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        let _ = self.app.emit_to("main", "navigate", "settings");
    }

    fn notify_main(&self, message: String) {
        let _ = self.app.emit_to("main", "notice", message);
    }

    pub fn bar_payload(&self) -> serde_json::Value {
        self.bar_payload
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn emit_bar(&self, payload: serde_json::Value) {
        *self
            .bar_payload
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = payload.clone();
        let _ = self.app.emit_to("bar", "bar-state", payload);
    }

    fn show_bar(&self) {
        let Some(window) = self.app.get_webview_window("bar") else {
            return;
        };
        if let Ok(hwnd) = window.hwnd() {
            if !self.bar_styled.swap(true, Ordering::SeqCst) {
                if let Err(error) = windows_util::style_bar(hwnd) {
                    eprintln!("[ray] {error}");
                }
            }
            // Tell Tauri the window is visible so it keeps the WebView painting;
            // WS_EX_NOACTIVATE means this never takes focus.
            let _ = window.show();
            let size = window
                .outer_size()
                .unwrap_or(tauri::PhysicalSize::new(360, 120));
            if let Err(error) = windows_util::show_bar(hwnd, size.width as i32, size.height as i32)
            {
                eprintln!("[ray] {error}");
            }
        } else {
            let _ = window.show();
        }
    }

    fn hide_bar(&self) {
        self.emit_bar(json!({ "phase": "hidden" }));
        if let Some(window) = self.app.get_webview_window("bar") {
            if let Ok(hwnd) = window.hwnd() {
                // Tauri's visibility bookkeeping can lag behind the raw
                // ShowWindow(SW_SHOWNOACTIVATE) above, so hide with Win32 too.
                windows_util::hide_bar(hwnd);
            }
            if let Err(error) = window.hide() {
                eprintln!("[ray] could not hide the bar: {error}");
            }
        }
    }
}
