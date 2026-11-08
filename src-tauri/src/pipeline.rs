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

use crate::api::{ApiError, ApiErrorKind};
use crate::audio::{self, Capture};
use crate::auth::{self, Auth};
use crate::cleanup;
use crate::config::RuntimeConfig;
use crate::hotkey;
use crate::paste;
use crate::store::{self, HistoryEntry, Store};
use crate::stt::{self, LiveSession};
use crate::windows_util;

struct Session {
    capture: Capture,
    stream: Option<LiveSession>,
    /// The device token this session's live request was started with. A 401
    /// must only clear this token, never a newer one from a later sign-in.
    token: String,
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
    auth: Arc<Auth>,
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
    /// The most recent transcript that History could not save. Kept in memory
    /// (and on the clipboard) so a disk failure never loses the dictation.
    unsaved_text: std::sync::Mutex<Option<String>>,
    /// Messages waiting for the main window to be opened. The window normally
    /// lives in the tray, and a toast fired while it is hidden expires unseen.
    buffered_notices: std::sync::Mutex<Vec<String>>,
    bar_payload: std::sync::Mutex<serde_json::Value>,
}

impl Dictation {
    pub fn new(
        app: AppHandle,
        store: Arc<Store>,
        auth: Arc<Auth>,
        config: RuntimeConfig,
    ) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .user_agent("Ray/0.1 (Windows)")
            .connect_timeout(Duration::from_secs(10))
            // Keep the pre-warmed connection alive through long recordings
            // and between dictations (reqwest defaults to 90 s).
            .pool_idle_timeout(Duration::from_secs(300))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Arc::new(Self {
            app,
            store,
            auth,
            config: RwLock::new(config),
            http,
            session: tokio::sync::Mutex::new(None),
            transition: tokio::sync::Mutex::new(()),
            recording: Arc::new(AtomicBool::new(false)),
            processing: AtomicBool::new(false),
            processing_window: std::sync::Mutex::new((None, None)),
            pending_note: std::sync::Mutex::new(None),
            unsaved_text: std::sync::Mutex::new(None),
            buffered_notices: std::sync::Mutex::new(Vec::new()),
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

    /// The effective Ray API origin, including the `RAY_API_BASE` override.
    pub fn api_base(&self) -> String {
        self.config
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .pipeline
            .api_base()
    }

    /// The public site origin used for the browser sign-in hand-off.
    pub fn site_url(&self) -> String {
        self.config
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .pipeline
            .site_url()
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
        if let Some(reason) = self.block_reason_fresh().await {
            self.block_dictation(reason).await;
            return;
        }
        let Some(token) = self.auth.token() else {
            self.block_dictation("Sign in to Ray to dictate").await;
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
        let api_base = pipeline.api_base();
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

        // Streaming is always on: Sync live transcribes while the user speaks
        // and leaves only the tail for the stop request.
        let stream = Some(stt::spawn_live(
            &api_base,
            &token,
            pipeline.stt.clone(),
            keyterms.clone(),
            self.http.clone(),
        ));
        // Warm the API connection while the user speaks, so the first
        // dictation does not pay a cold TLS handshake after the hotkey is
        // released.
        if settings.cleanup_enabled && pipeline.cleanup.enabled {
            let http = self.http.clone();
            let api_base = api_base.clone();
            tokio::spawn(async move {
                cleanup::warm_connection(&http, &api_base).await;
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
            token,
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
            token: session_token,
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
        let api_base = pipeline.api_base();
        let mut raw: Option<String> = None;
        let mut from_stream = false;
        let mut stt_error: Option<ApiError> = None;
        // Text from live segments that completed before a failure. It is the
        // last-resort transcript if both batch fallbacks also fail, and the
        // required result when a later rollover segment hits the limit.
        let mut partial: Option<String> = None;
        // PCM already transcribed (and counted) by completed live segments.
        // The batch fallback starts after it so the same audio is not counted
        // against the weekly quota twice.
        let mut live_covered_bytes = 0usize;
        // Read progress through a handle: `finish` consumes the session.
        let live_progress = stream.as_ref().map(LiveSession::progress_handle);
        // Shown after the transcript is pasted: the dictation is never lost
        // because of a quota, auth, or cleanup failure.
        let mut quota_notice: Option<String> = None;
        let mut auth_notice = false;

        if let Some(stream) = stream {
            let timeout = Duration::from_millis(pipeline.stt.force_endpoint_timeout_ms + 5_000);
            match stream.finish(timeout).await {
                Ok(text) if !text.trim().is_empty() => {
                    raw = Some(text.trim().to_string());
                    from_stream = true;
                }
                Ok(_) => eprintln!("[ray] streaming returned no text; trying batch"),
                Err(failure) => {
                    partial = failure.partial.clone();
                    if failure.is_fatal() {
                        if partial
                            .as_deref()
                            .is_some_and(|text| !text.trim().is_empty())
                        {
                            // Decision 5: a later rollover segment hit quota (or
                            // the session expired). Keep and paste what was
                            // already transcribed, then show the reason.
                            raw = partial.take();
                            from_stream = true;
                            match failure.error.kind {
                                ApiErrorKind::Unauthorized => {
                                    if self.auth.sign_out_if_token(&session_token) {
                                        let _ = self.app.emit("account-changed", self.auth.state());
                                    }
                                    auth_notice = true;
                                }
                                ApiErrorKind::QuotaExceeded | ApiErrorKind::FairUse => {
                                    quota_notice = Some(failure.error.to_string());
                                }
                                ApiErrorKind::DeviceLimit => {
                                    quota_notice =
                                        Some("Free limit reached on this PC".to_string());
                                }
                                ApiErrorKind::Other => {}
                            }
                        } else {
                            // Nothing was transcribed yet, so there is no
                            // transcript to lose.
                            self.finish_with_error(failure.error, &session_token).await;
                            return;
                        }
                    } else {
                        eprintln!("[ray] streaming failed; trying batch: {}", failure.error);
                        if let Some(progress) = &live_progress {
                            live_covered_bytes = progress.covered_bytes();
                        }
                        stt_error = Some(failure.error);
                    }
                }
            }
        }

        if raw.is_none() {
            if let Some(token) = self.auth.token() {
                let http = self.http.clone();
                let stt_config = pipeline.stt.clone();
                let terms = keyterms.clone();
                // Only the audio live never covered is sent to batch: its
                // words were already added to the weekly and fair-use counts.
                let batch_start = batch_sample_offset(live_covered_bytes, samples.len());
                let batch_samples = &samples[batch_start..];
                // Sync batch and the Worker's v2 proxy run sequentially; the
                // budget covers both worst cases plus a margin. A header-only
                // WAV (live covered everything) would only return no speech.
                let timeout = stt::batch_time_budget(&pipeline.stt);
                let batch = async {
                    if batch_samples.len() < 1_600 {
                        return Ok(String::new());
                    }
                    let wav = stt::wav_from_pcm16(batch_samples, audio::TARGET_RATE);
                    stt::transcribe_wav(&http, &api_base, &token, &terms, wav, &stt_config).await
                };
                match tokio::time::timeout(timeout, batch).await {
                    Ok(Ok(text)) if !text.trim().is_empty() => {
                        let text = text.trim();
                        raw = Some(match partial.as_deref() {
                            Some(previous) => stt::join_batch_transcripts(previous, text),
                            None => text.to_string(),
                        });
                    }
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) if error.is_fatal() => {
                        if partial
                            .as_deref()
                            .is_some_and(|text| !text.trim().is_empty())
                        {
                            // The fallback hit quota mid-dictation: never drop
                            // the live segments that already exist.
                            raw = partial.take();
                            from_stream = true;
                            match error.kind {
                                ApiErrorKind::Unauthorized => {
                                    if self.auth.sign_out_if_token(&token) {
                                        let _ = self.app.emit("account-changed", self.auth.state());
                                    }
                                    auth_notice = true;
                                }
                                ApiErrorKind::QuotaExceeded | ApiErrorKind::FairUse => {
                                    quota_notice = Some(error.to_string());
                                }
                                ApiErrorKind::DeviceLimit => {
                                    quota_notice =
                                        Some("Free limit reached on this PC".to_string());
                                }
                                ApiErrorKind::Other => {}
                            }
                        } else {
                            self.finish_with_error(error, &token).await;
                            return;
                        }
                    }
                    Ok(Err(error)) => {
                        eprintln!("[ray] batch transcription failed: {error}");
                        stt_error = Some(error);
                    }
                    Err(_) => {
                        eprintln!("[ray] batch transcription timed out");
                        stt_error = Some(ApiError::other("timed out"));
                    }
                }
            }
        }

        // Both fallbacks failed, but live segments did produce text: paste
        // that instead of reporting a failed dictation.
        if raw.is_none() {
            if let Some(partial) = partial.take() {
                raw = Some(partial);
                from_stream = true;
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
            let no_speech = had_raw || is_no_speech_error(stt_error.as_ref());
            if no_speech {
                self.fail("Didn't catch that. Try again.").await;
            } else {
                self.fail(stt_failure_message(stt_error.as_ref())).await;
            }
            return;
        };

        let settings = self.store.settings();
        let cleanup_config = &pipeline.cleanup;
        let mut text = raw_text.clone();
        let mut note: Option<String> = None;
        let mut cleaned = false;
        if cleanup_enabled && pipeline.cleanup.enabled {
            let dictionary = self.store.dictionary();
            let app_name = target
                .as_ref()
                .and_then(|target| target.app.clone())
                .unwrap_or_else(|| "Unknown app".into());
            let timeout = Duration::from_millis(cleanup_config.timeout_ms + 6_000);
            match tokio::time::timeout(
                timeout,
                cleanup::cleanup(
                    &self.http,
                    &api_base,
                    &session_token,
                    cleanup_config,
                    cleanup::CleanupInput {
                        template: &cleanup_prompt,
                        transcript: &raw_text,
                        dictionary: &dictionary,
                        known_names: &pipeline.known_names,
                        app_name: &app_name,
                    },
                ),
            )
            .await
            {
                Ok(result) => {
                    if let Some(error) = result.fatal {
                        // Any cleanup failure keeps the raw transcript. A 402/
                        // 429/403 already arrives here as a normal failure;
                        // only a Ray session error is left, and it must still
                        // paste what the user said before signing out.
                        match error.kind {
                            ApiErrorKind::Unauthorized => {
                                if self.auth.sign_out_if_token(&session_token) {
                                    let _ = self.app.emit("account-changed", self.auth.state());
                                }
                                auth_notice = true;
                            }
                            ApiErrorKind::QuotaExceeded | ApiErrorKind::FairUse => {
                                quota_notice = Some(error.to_string());
                            }
                            ApiErrorKind::DeviceLimit => {
                                quota_notice = Some("Free limit reached on this PC".to_string());
                            }
                            ApiErrorKind::Other => {}
                        }
                    } else {
                        cleaned = result.provider.is_some();
                        text = result.text;
                        note = result.note;
                    }
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
            // Structured is the only cleanup mode, but the field stays for
            // older History entries and for the CRLF clipboard convention.
            // A raw transcript (cleanup failed or was disabled) is mode null.
            mode: cleaned.then(|| "structured".to_string()),
        };
        let history_saved = match self.store.add_history(entry) {
            Ok(()) => true,
            Err(error) => {
                eprintln!("[ray] could not save history: {error}");
                // The store leaves the entry out of memory when the write
                // fails, so hold a recovery copy and keep the transcript on
                // the clipboard (see `keep_on_clipboard` below).
                *self
                    .unsaved_text
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(text.clone());
                false
            }
        };
        let _ = self.app.emit_to("main", "state-changed", ());
        if let Some(note) = note {
            eprintln!("[ray] {note}");
        }
        // Keep the plan/usage badge current after every dictation.
        auth::refresh_shared(&self.app, &self.auth, &self.http, &api_base);

        // Structured output is multi-line (paragraphs and list markers). The
        // Windows clipboard convention for CF_UNICODETEXT is CRLF.
        let line_endings = if cleaned {
            paste::LineEndings::CrLf
        } else {
            paste::LineEndings::Preserve
        };
        let pasted = {
            let text = text.clone();
            let target = target.as_ref().map(|target| target.hwnd);
            // Without History, the clipboard is the only durable copy left.
            let keep_on_clipboard = !history_saved;
            tokio::task::spawn_blocking(move || {
                paste::paste_text(&text, target, keep_on_clipboard, line_endings)
            })
            .await
        };
        match pasted {
            Ok(Ok(outcome)) => {
                if outcome.previous_clipboard_lost {
                    notes.push(
                        "Your previous clipboard contents (files or rich content) couldn't be restored."
                            .into(),
                    );
                }
                if !history_saved {
                    notes.push(
                        "This dictation couldn't be saved to History. The text is on your clipboard."
                            .into(),
                    );
                }
            }
            Ok(Err(error)) => match paste::copy_text_with(&text, line_endings) {
                Ok(()) if history_saved => notes.push(format!(
                    "Couldn't paste automatically ({error}). The text is copied to your clipboard and saved in History."
                )),
                Ok(()) => notes.push(format!(
                    "Couldn't paste automatically ({error}). The text is copied to your clipboard; History couldn't save it either."
                )),
                Err(copy_error) if history_saved => notes.push(format!(
                    "Couldn't paste ({error}) or copy the text ({copy_error}). It is saved in History."
                )),
                Err(copy_error) => notes.push(format!(
                    "Couldn't paste ({error}) or copy the text ({copy_error}). History couldn't save it either; the transcript is kept until Ray quits."
                )),
            },
            Err(error) => match paste::copy_text_with(&text, line_endings) {
                Ok(()) if history_saved => notes.push(format!(
                    "The paste task failed ({error}). The text is copied to your clipboard and saved in History."
                )),
                Ok(()) => notes.push(format!(
                    "The paste task failed ({error}). The text is copied to your clipboard; History couldn't save it either."
                )),
                Err(copy_error) if history_saved => notes.push(format!(
                    "The paste task failed ({error}) and the text couldn't be copied ({copy_error}). It is saved in History."
                )),
                Err(copy_error) => notes.push(format!(
                    "The paste task failed ({error}) and the text couldn't be copied ({copy_error}). History couldn't save it either; the transcript is kept until Ray quits."
                )),
            },
        }
        // The transcript is pasted and saved by now. Only then explain the
        // limit or the expired session, so the post-paste bar message never
        // replaces the user's words.
        if auth_notice {
            notes.push("Sign in to Ray to dictate".into());
            self.show_main();
        }
        if let Some(message) = quota_notice {
            notes.push(message);
            self.open_main_on("account");
        }
        let warned = !notes.is_empty();
        let warning = notes.join(" ");
        for note in notes {
            self.notify_main(note);
        }

        if warned {
            // Reuse the bar's existing error look so a failed paste, a mic
            // problem, or a lost History save is visible even when the main
            // window is in the tray. The explanation is buffered by
            // `notify_main` until that window is opened.
            self.emit_bar(json!({ "phase": "error", "message": warning }));
            tokio::time::sleep(Duration::from_millis(1_600)).await;
        } else {
            self.emit_bar(json!({ "phase": "done" }));
            tokio::time::sleep(Duration::from_millis(520)).await;
        }
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

    /// Show why recording did not start, and bring up the main window so the
    /// user can sign in or see the limit.
    async fn block_dictation(&self, reason: &str) {
        if reason == "Weekly limit reached" {
            self.open_main_on("account");
        } else {
            self.show_main();
        }
        self.fail(reason).await;
    }

    /// The cached quota gate. Decision 15: cached usage whose `resets_at` has
    /// passed is stale, so ask `/api/me` once (short timeout) before refusing
    /// to record. If that refresh fails, allow the recording and let the
    /// server decide.
    async fn block_reason_fresh(&self) -> Option<&'static str> {
        // A hotkey press can beat the background credential read on launch.
        self.auth.wait_loaded(Duration::from_millis(500)).await;
        if !self.auth.is_signed_in() {
            return Some("Sign in to Ray to dictate");
        }
        let account = self.auth.account();
        let over_limit = account
            .as_ref()
            .is_some_and(|account| account.starter_is_over_limit());
        if !over_limit {
            return None;
        }
        if !account
            .as_ref()
            .is_some_and(|account| account.usage_is_stale())
        {
            return Some("Weekly limit reached");
        }
        let api_base = self.api_base();
        let http = self.http.clone();
        match tokio::time::timeout(
            Duration::from_secs(4),
            auth::refresh(&self.auth, &http, &api_base),
        )
        .await
        {
            Ok(Ok(_)) => {}
            // A 401 already cleared the token; treat it as signed out.
            Ok(Err(error)) if error.kind == ApiErrorKind::Unauthorized => {}
            // Unreachable or failed refresh: do not lock the user out of a
            // week that has already rolled over.
            Ok(Err(_)) | Err(_) => return None,
        }
        if !self.auth.is_signed_in() {
            return Some("Sign in to Ray to dictate");
        }
        if self
            .auth
            .account()
            .is_some_and(|account| account.starter_is_over_limit())
        {
            return Some("Weekly limit reached");
        }
        None
    }

    /// A fatal STT error with no transcript to paste: stop the session with
    /// the right message. `token` is the token the failed request used, so a
    /// stale 401 can never clear a newer session.
    async fn finish_with_error(&self, error: ApiError, token: &str) {
        let kind = error.kind;
        let mut signed_out = false;
        let message = match kind {
            ApiErrorKind::Unauthorized => {
                signed_out = self.auth.sign_out_if_token(token);
                if signed_out {
                    let _ = self.app.emit("account-changed", self.auth.state());
                    "Sign in to Ray to dictate".to_string()
                } else {
                    // The current session is newer than this request; do not
                    // tell the user to sign in again.
                    error.to_string()
                }
            }
            ApiErrorKind::QuotaExceeded => error
                .message
                .clone()
                .unwrap_or_else(|| "Weekly limit reached".into()),
            ApiErrorKind::FairUse => error
                .message
                .clone()
                .unwrap_or_else(|| "Fair-use limit reached, resets Monday".into()),
            ApiErrorKind::DeviceLimit => "Free limit reached on this PC".to_string(),
            ApiErrorKind::Other => error.to_string(),
        };
        match kind {
            ApiErrorKind::Unauthorized => {
                if signed_out {
                    self.show_main();
                }
            }
            ApiErrorKind::QuotaExceeded | ApiErrorKind::FairUse | ApiErrorKind::DeviceLimit => {
                self.open_main_on("account");
                // The proxy's count is authoritative; refresh the meter.
                auth::refresh_shared(&self.app, &self.auth, &self.http, &self.api_base());
            }
            ApiErrorKind::Other => {}
        }
        self.fail(&message).await;
    }

    fn open_main_on(&self, page: &str) {
        self.show_main();
        let _ = self.app.emit_to("main", "navigate", page);
    }

    fn show_main(&self) {
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }

    fn notify_main(&self, message: String) {
        eprintln!("[ray] {message}");
        if main_window_visible(&self.app) {
            let _ = self.app.emit_to("main", "notice", message);
            return;
        }
        // The main window normally sits hidden in the tray, where an emitted
        // toast runs its timer unseen. Keep the recent messages (one stop can
        // produce several); the window's focus event calls `deliver_notice`
        // once it is actually on screen.
        let mut buffered = self
            .buffered_notices
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if buffered.last() != Some(&message) {
            buffered.push(message);
        }
        let excess = buffered.len().saturating_sub(MAX_BUFFERED_NOTICES);
        buffered.drain(..excess);
    }

    /// Shows the notices that arrived while the main window was hidden, as
    /// one toast. Called from the main window's focus handler.
    pub fn deliver_notice(&self) {
        if !main_window_visible(&self.app) {
            return;
        }
        let messages = std::mem::take(
            &mut *self
                .buffered_notices
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        if !messages.is_empty() {
            let _ = self.app.emit_to("main", "notice", messages.join(" "));
        }
    }

    /// The last transcript whose History write failed, if any. Exposed so it
    /// can be copied even when neither History nor the clipboard has it.
    pub fn unsaved_text(&self) -> Option<String> {
        self.unsaved_text
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
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

/// Older notices are dropped beyond this; the newest explain the current state.
const MAX_BUFFERED_NOTICES: usize = 4;

/// Sample index where the batch fallback must start. Live segments send their
/// audio as PCM16 bytes (two per sample), and their covered end is already
/// counted by the Worker, so re-sending it would overcharge the quota.
fn batch_sample_offset(covered_bytes: usize, sample_count: usize) -> usize {
    (covered_bytes / 2).min(sample_count)
}

/// True when the main window is on screen rather than hidden in the tray or
/// minimized. A toast shown while minimized also expires before the user can
/// see it, so both count as "not visible".
fn main_window_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
    })
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

/// Turns an STT error into something the user can act on. Quota/auth errors
/// are handled earlier by `finish_with_error` and never reach this.
fn stt_failure_message(error: Option<&ApiError>) -> &'static str {
    let Some(error) = error else {
        return "Transcription failed. Check your connection and try again.";
    };
    let error = error.to_string().to_lowercase();
    if error.contains("error sending request")
        || error.contains("dns")
        || error.contains("connect")
        || error.contains("timed out")
        || error.contains("timeout")
        || error.contains("network")
        || error.contains("tls")
        || error.contains("proxy")
    {
        return "Couldn't reach Ray. Check your connection and try again.";
    }
    "Transcription failed. Check your connection and try again."
}

/// Distinguishes "the user said nothing" from a real network failure so the
/// bar does not tell them to check their connection after a silent clip.
fn is_no_speech_error(error: Option<&ApiError>) -> bool {
    error.is_some_and(|error| {
        let error = error.to_string().to_lowercase();
        error.contains("no speech")
            || error.contains("empty transcript")
            || error.contains("without a transcript")
    })
}

#[cfg(test)]
mod tests {
    use super::{batch_sample_offset, is_no_speech_error, stt_failure_message};
    use crate::api::ApiError;

    #[test]
    fn batch_fallback_skips_audio_live_already_counted() {
        // PCM16: two bytes per sample, clamped to the captured buffer.
        assert_eq!(batch_sample_offset(0, 16_000), 0);
        assert_eq!(batch_sample_offset(32_000, 16_000), 16_000);
        assert_eq!(batch_sample_offset(3_200, 16_000), 1_600);
        assert_eq!(batch_sample_offset(usize::MAX, 16_000), 16_000);
    }

    #[test]
    fn explains_network_failures_without_blaming_a_key() {
        assert_eq!(
            stt_failure_message(None),
            "Transcription failed. Check your connection and try again."
        );
        assert!(
            stt_failure_message(Some(&ApiError::other("error sending request for url")))
                .contains("Couldn't reach Ray")
        );
        assert!(
            stt_failure_message(Some(&ApiError::other("timed out"))).contains("Couldn't reach Ray")
        );
        assert!(
            stt_failure_message(Some(&ApiError::other("Ray Sync live 500: boom")))
                .contains("Transcription failed")
        );
    }

    #[test]
    fn recognises_silence_instead_of_reporting_a_connection_error() {
        assert!(is_no_speech_error(Some(&ApiError::other(
            "No speech was detected"
        ))));
        assert!(is_no_speech_error(Some(&ApiError::other(
            "Ray returned an empty transcript"
        ))));
        assert!(!is_no_speech_error(Some(&ApiError::other(
            "Ray Sync live 500: boom"
        ))));
        assert!(!is_no_speech_error(None));
    }
}
