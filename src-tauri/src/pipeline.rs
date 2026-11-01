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
    limit_task: tokio::task::JoinHandle<()>,
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
    /// First and last instant of the current/last processing phase. Hotkey
    /// presses that happened inside this window are stale by the time the
    /// pipeline is free to read them; they must not start a new dictation.
    processing_window: std::sync::Mutex<(Option<Instant>, Option<Instant>)>,
    pending_note: std::sync::Mutex<Option<String>>,
    bar_payload: std::sync::Mutex<serde_json::Value>,
}

impl Dictation {
    pub fn new(app: AppHandle, store: Arc<Store>, config: RuntimeConfig) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .user_agent("Ray/0.1 (Windows)")
            .connect_timeout(Duration::from_secs(10))
            // Keep the pre-warmed gateway connection alive through long
            // recordings and between dictations (reqwest defaults to 90 s).
            .pool_idle_timeout(Duration::from_secs(300))
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
            processing_window: std::sync::Mutex::new((None, None)),
            pending_note: std::sync::Mutex::new(None),
            bar_payload: std::sync::Mutex::new(json!({ "phase": "hidden" })),
        })
    }

    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::SeqCst)
    }

    pub fn is_processing(&self) -> bool {
        self.processing.load(Ordering::SeqCst)
    }

    /// A press made while the previous stop was still running should be
    /// dropped, not queued into a surprise new recording once it finishes.
    pub fn should_ignore_toggle(&self, at: Instant) -> bool {
        let window = self
            .processing_window
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match *window {
            (Some(since), Some(until)) => at >= since && at <= until,
            (Some(since), None) => at >= since,
            _ => false,
        }
    }

    fn begin_processing(&self) {
        let mut window = self
            .processing_window
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if window.0.is_none() {
            window.0 = Some(Instant::now());
        }
        window.1 = None;
    }

    fn end_processing(&self) {
        let mut window = self
            .processing_window
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if window.0.is_some() {
            window.1 = Some(Instant::now());
        }
    }

    fn reset_processing_window(&self) {
        *self
            .processing_window
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = (None, None);
    }

    fn set_pending_note(&self, note: impl Into<String>) {
        *self
            .pending_note
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(note.into());
    }

    fn take_pending_note(&self) -> Option<String> {
        self.pending_note
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
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
        // A genuinely new session: presses from here on are no longer stale.
        self.reset_processing_window();
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
        // Warm the LLM gateway while the user speaks, so the first dictation
        // does not pay a cold TLS handshake after the hotkey is released.
        if settings.cleanup_enabled && pipeline.cleanup.enabled {
            let http = self.http.clone();
            let cleanup_config = pipeline.cleanup.clone();
            tokio::spawn(async move {
                cleanup::warm_connection(&http, &cleanup_config).await;
            });
        }
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

        if let Some(warning) = capture.warning() {
            self.notify_main(warning);
        }
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

        // A recording cannot outlive the audio buffer used for the batch
        // fallback. Stop at that limit instead of silently dropping the tail.
        let limit_seconds = audio::max_recording_seconds();
        let limit_task = {
            let dictation = self.clone();
            let recording = self.recording.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(limit_seconds)).await;
                if recording.load(Ordering::SeqCst) {
                    dictation.set_pending_note(format!(
                        "Recording stopped at the {} limit.",
                        audio::limit_label(limit_seconds)
                    ));
                    // Do not call stop() from the task it is about to abort.
                    let this = dictation.clone();
                    tokio::spawn(async move {
                        this.stop().await;
                    });
                }
            })
        };

        *self.session.lock().await = Some(Session {
            capture,
            stream,
            started,
            target,
            keyterms,
            cleanup_enabled: settings.cleanup_enabled,
            level_task,
            limit_task,
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
        self.begin_processing();
        // Dropping the guard clears `processing` even if a future step panics,
        // so a bug can never leave the hotkey permanently dead.
        let _processing_guard = ProcessingGuard(self.as_ref());
        self.emit_bar(json!({ "phase": "processing" }));

        let Some(session) = self.session.lock().await.take() else {
            return;
        };
        let Session {
            capture,
            stream,
            started,
            target,
            keyterms,
            cleanup_enabled,
            level_task,
            limit_task,
        } = session;
        level_task.abort();
        limit_task.abort();

        let duration_ms = started.elapsed().as_millis() as u64;
        let audio_error = capture.error();
        let truncated = capture.truncated();
        let mut notes: Vec<String> = Vec::new();
        if let Some(note) = self.take_pending_note() {
            notes.push(note);
        }

        // Some drivers block while tearing the stream down. Do not let that
        // hang the whole pipeline; snapshot what was captured and move on.
        capture.request_stop();
        let pcm = capture.pcm_handle();
        let stopped = tokio::time::timeout(
            Duration::from_secs(6),
            tokio::task::spawn_blocking(move || capture.join()),
        )
        .await;
        if !matches!(stopped, Ok(Ok(()))) {
            notes.push(
                "The microphone did not stop cleanly; transcribed the audio captured so far."
                    .into(),
            );
        }
        let samples = pcm
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();

        if samples.len() < 1_600 {
            let message = audio_error
                .or_else(|| notes.first().cloned())
                .unwrap_or_else(|| "Didn't catch that. Try again.".into());
            self.fail(&message).await;
            return;
        }
        if let Some(error) = audio_error {
            notes.push(format!(
                "The microphone stopped during recording ({error}). The audio before it was transcribed."
            ));
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
        let mut from_stream = false;
        let mut stt_error: Option<String> = None;

        if let Some(stream) = stream {
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
                Ok(text) if !text.trim().is_empty() => {
                    raw = Some(text.trim().to_string());
                    from_stream = true;
                }
                Ok(_) => eprintln!("[ray] streaming returned no text; trying batch"),
                Err(error) => {
                    eprintln!("[ray] streaming failed; trying batch: {error}");
                    stt_error = Some(error);
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
                    Ok(Err(error)) => {
                        eprintln!("[ray] batch transcription failed: {error}");
                        stt_error = Some(error);
                    }
                    Err(_) => {
                        eprintln!("[ray] batch transcription timed out");
                        stt_error = Some("timed out".into());
                    }
                }
            }
        }

        // Only the remote fallback uses the local buffer, so only warn about
        // its length when the live path did not produce the transcript.
        if truncated && !from_stream {
            notes.push(format!(
                "Recording reached the {}-minute buffer limit; the end may be missing.",
                audio::MAX_RECORDING_SECONDS / 60
            ));
        }

        let had_raw = raw.is_some();
        let raw_text = raw
            .map(|text| cleanup::sanitize_transcript(&text))
            .filter(|text| !text.is_empty());
        let Some(raw_text) = raw_text else {
            // Silence and noise-only clips are not a connection problem.
            let no_speech = had_raw || is_no_speech_error(stt_error.as_deref());
            if no_speech {
                self.fail("Didn't catch that. Try again.").await;
            } else {
                self.fail(stt_failure_message(stt_error.as_deref())).await;
            }
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
        match pasted {
            Ok(Ok(outcome)) => {
                if outcome.previous_clipboard_lost {
                    notes.push(
                        "Your previous clipboard contents (files or rich content) couldn't be restored."
                            .into(),
                    );
                }
            }
            Ok(Err(error)) => {
                match paste::copy_text(&text) {
                    Ok(()) => notes.push(format!(
                        "Couldn't paste automatically ({error}). The text is copied to your clipboard and saved in History."
                    )),
                    Err(copy_error) => notes.push(format!(
                        "Couldn't paste ({error}) or copy the text ({copy_error}). It is saved in History."
                    )),
                }
            }
            Err(error) => {
                notes.push(format!(
                    "The paste task failed ({error}). The text is saved in History."
                ));
            }
        }
        for note in notes {
            self.notify_main(note);
        }

        self.emit_bar(json!({ "phase": "done" }));
        tokio::time::sleep(Duration::from_millis(520)).await;
        self.hide_bar();
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
            session.limit_task.abort();
            if let Some(stream) = session.stream {
                stream.abort();
            }
            session.capture.request_stop();
            let capture = session.capture;
            // Detach the join: cancelling must feel instant even if a driver
            // is slow to tear the stream down.
            std::mem::drop(tokio::task::spawn_blocking(move || capture.join()));
        }
        self.hide_bar();
        self.processing.store(false, Ordering::SeqCst);
    }

    async fn fail(&self, message: &str) {
        eprintln!("[ray] {message}");
        self.begin_processing();
        self.processing.store(true, Ordering::SeqCst);
        let _guard = ProcessingGuard(self);
        self.emit_bar(json!({ "phase": "error", "message": message }));
        self.show_bar();
        self.notify_main(message.to_string());
        tokio::time::sleep(Duration::from_millis(1_600)).await;
        self.hide_bar();
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
        eprintln!("[ray] {message}");
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
            // Tauri's show() rewrites the extended styles, so show the window
            // through Win32 only and re-apply the bar styles every time.
            if let Err(error) = windows_util::style_bar(hwnd) {
                eprintln!("[ray] {error}");
            }
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
                windows_util::hide_bar(hwnd);
            }
        }
    }
}

/// Clears the processing flag and closes the stale-press window on every exit
/// path, including early returns and panics. Without this, one unexpected
/// error would leave the hotkey permanently dead.
struct ProcessingGuard<'a>(&'a Dictation);

impl Drop for ProcessingGuard<'_> {
    fn drop(&mut self) {
        self.0.processing.store(false, Ordering::SeqCst);
        self.0.end_processing();
    }
}

/// Turns an STT error into something the user can act on.
fn stt_failure_message(error: Option<&str>) -> &'static str {
    let Some(error) = error else {
        return "Transcription failed. Check your connection and AssemblyAI key.";
    };
    let error = error.to_lowercase();
    if error.contains("401")
        || error.contains("403")
        || error.contains("unauthorized")
        || error.contains("invalid api key")
        || error.contains("authentication")
    {
        return "AssemblyAI rejected your key. Check it in Settings.";
    }
    if error.contains("error sending request")
        || error.contains("dns")
        || error.contains("connect")
        || error.contains("timed out")
        || error.contains("timeout")
        || error.contains("network")
        || error.contains("tls")
        || error.contains("proxy")
    {
        return "Couldn't reach AssemblyAI. Check your connection and try again.";
    }
    "Transcription failed. Check your connection and AssemblyAI key."
}

/// Distinguishes "the user said nothing" from a real network/key failure so the
/// bar does not tell them to check their connection after a silent clip.
fn is_no_speech_error(error: Option<&str>) -> bool {
    error.is_some_and(|error| {
        let error = error.to_lowercase();
        error.contains("no speech")
            || error.contains("empty transcript")
            || error.contains("without a transcript")
    })
}

#[cfg(test)]
mod tests {
    use super::{is_no_speech_error, stt_failure_message};

    #[test]
    fn explains_bad_keys_and_network_failures_differently() {
        assert!(
            stt_failure_message(Some("AssemblyAI Sync live 401 Unauthorized"))
                .contains("rejected your key")
        );
        assert!(stt_failure_message(Some("error sending request for url"))
            .contains("Couldn't reach AssemblyAI"));
        assert!(stt_failure_message(Some("timed out")).contains("Couldn't reach AssemblyAI"));
        assert!(stt_failure_message(Some("AssemblyAI Sync live 500: boom"))
            .contains("Transcription failed"));
        assert!(stt_failure_message(None).contains("Transcription failed"));
    }

    #[test]
    fn recognises_silence_instead_of_reporting_a_connection_error() {
        assert!(is_no_speech_error(Some("No speech was detected")));
        assert!(is_no_speech_error(Some(
            "AssemblyAI returned an empty transcript"
        )));
        assert!(is_no_speech_error(Some(
            "AssemblyAI closed the stream without a transcript"
        )));
        assert!(!is_no_speech_error(Some(
            "AssemblyAI Sync live 401 Unauthorized"
        )));
        assert!(!is_no_speech_error(None));
    }
}
