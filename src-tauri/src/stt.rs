//! AssemblyAI speech-to-text.
//!
//! Primary: Sync live (`POST https://sync.assemblyai.com/v1/transcribe/live`),
//! a chunked multipart request whose config part is sent up front and whose
//! audio part is streamed while the user speaks. It transcribes during the
//! upload, so stopping only leaves the tail and final decode (~0.5 s).
//!
//! Alternatives kept behind the same interface:
//! - Universal Streaming over WebSocket (partial turns while speaking).
//! - Sync batch, then the older asynchronous v2 upload/poll API, using the
//!   locally buffered WAV when live fails.
use crate::config::{BatchConfig, SttConfig};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use url::Url;
const WEBSOCKET_URL: &str = "wss://streaming.assemblyai.com/v3/ws";
const V2_URL: &str = "https://api.assemblyai.com/v2";
static BOUNDARY_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Aborts a spawned request when the task that owns it is cancelled. Without
/// this, a stalled upload keeps its connection (and its request timeout) alive
/// after the app has already fallen back to batch.
struct AbortOnDrop(tokio::task::AbortHandle);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}
/// One live transcription session, whichever protocol the config selects.
pub enum LiveSession {
    WebSocket(StreamSession),
    SyncLive(SyncLiveSession),
}
impl LiveSession {
    pub fn audio_sender(&self) -> mpsc::UnboundedSender<Vec<u8>> {
        match self {
            Self::WebSocket(session) => session.audio_tx.clone(),
            Self::SyncLive(session) => session.audio_tx.clone(),
        }
    }
    pub async fn finish(self, timeout: Duration) -> Result<String, String> {
        match self {
            Self::WebSocket(session) => session.finish(timeout).await,
            Self::SyncLive(session) => session.finish(timeout).await,
        }
    }
    pub fn abort(self) {
        match self {
            Self::WebSocket(session) => session.abort(),
            Self::SyncLive(session) => session.abort(),
        }
    }
}
pub fn spawn_live(
    api_key: String,
    config: SttConfig,
    keyterms: Vec<String>,
    http: reqwest::Client,
) -> LiveSession {
    if config.mode.eq_ignore_ascii_case("websocket") {
        LiveSession::WebSocket(spawn_stream(api_key, config, keyterms))
    } else {
        LiveSession::SyncLive(spawn_sync_live(api_key, config, keyterms, http))
    }
}
// ---------------------------------------------------------------------------
// Sync live (recommended)
// ---------------------------------------------------------------------------
pub struct SyncLiveSession {
    pub audio_tx: mpsc::UnboundedSender<Vec<u8>>,
    stop_tx: watch::Sender<bool>,
    task: JoinHandle<Result<String, String>>,
}
impl SyncLiveSession {
    pub async fn finish(self, timeout: Duration) -> Result<String, String> {
        let _ = self.stop_tx.send(true);
        let mut task = self.task;
        tokio::select! {
            result = &mut task => match result {
                Ok(result) => result,
                Err(error) => Err(format!("Sync live task failed: {error}")),
            },
            _ = tokio::time::sleep(timeout) => {
                // Do not leave a stalled upload running: it would hold the
                // connection and its 300 s request timeout while the batch
                // fallback already has the audio.
                task.abort();
                Err("Sync live did not finish in time".into())
            }
        }
    }
    pub fn abort(self) {
        let _ = self.stop_tx.send(true);
        self.task.abort();
    }
}
pub fn spawn_sync_live(
    api_key: String,
    config: SttConfig,
    keyterms: Vec<String>,
    http: reqwest::Client,
) -> SyncLiveSession {
    let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = watch::channel(false);
    let task = tokio::spawn(async move {
        run_sync_live(&api_key, &config, &keyterms, audio_rx, stop_rx, http).await
    });
    SyncLiveSession {
        audio_tx,
        stop_tx,
        task,
    }
}
async fn run_sync_live(
    api_key: &str,
    config: &SttConfig,
    keyterms: &[String],
    mut audio_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    stop_rx: watch::Receiver<bool>,
    http: reqwest::Client,
) -> Result<String, String> {
    // Stay a little under the endpoint's 120 s audio cap per request.
    let segment_seconds = config.sync_live.max_audio_seconds.saturating_sub(2).max(1);
    let max_bytes = (segment_seconds * config.sample_rate as u64 * 2) as usize;
    let mut transcripts: Vec<String> = Vec::new();
    let mut pending: Option<Vec<u8>> = None;
    // A hard 118 s cut can land inside a word. Re-send the last second of the
    // finished segment at the start of the next one, then remove the repeated
    // words when joining, so no word is lost or duplicated.
    let overlap_bytes = (config.sample_rate as usize * 2).min(max_bytes / 4);
    let mut overlap: Option<Vec<u8>> = None;
    let mut audio_tail: Vec<u8> = Vec::new();
    loop {
        let boundary = boundary();
        let config_json = sync_config(config, keyterms)?;
        let head = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"config\"\r\nContent-Type: application/json\r\n\r\n{config_json}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"audio.pcm\"\r\nContent-Type: audio/pcm\r\n\r\n"
        );
        let tail = format!("\r\n--{boundary}--\r\n");
        let (body_tx, body_rx) = mpsc::channel::<Result<Bytes, io::Error>>(128);
        body_tx
            .send(Ok(Bytes::from(head)))
            .await
            .map_err(|_| "Could not start the upload")?;
        let mut segment_stop = stop_rx.clone();
        let request = http
            .post(&config.sync_live.endpoint)
            .header("authorization", api_key)
            .header("X-AAI-Model", &config.sync_live.model)
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .timeout(Duration::from_millis(
                config.sync_live.request_timeout_ms.max(30_000),
            ))
            .body(reqwest::Body::wrap_stream(futures_util::stream::unfold(
                body_rx,
                |mut rx| async move { rx.recv().await.map(|item| (item, rx)) },
            )));
        let send_task = tokio::spawn(request.send());
        let _abort_on_drop = AbortOnDrop(send_task.abort_handle());
        let pump = async {
            let mut sent = 0usize;
            if let Some(bytes) = overlap.take() {
                sent += bytes.len();
                keep_tail(&mut audio_tail, &bytes, overlap_bytes);
                if body_tx.send(Ok(Bytes::from(bytes))).await.is_err() {
                    let _ = body_tx.send(Ok(Bytes::from(tail.clone()))).await;
                    return true;
                }
            }
            if let Some(chunk) = pending.take() {
                sent += chunk.len();
                keep_tail(&mut audio_tail, &chunk, overlap_bytes);
                if body_tx.send(Ok(Bytes::from(chunk))).await.is_err() {
                    let _ = body_tx.send(Ok(Bytes::from(tail.clone()))).await;
                    return true;
                }
            }
            let mut stopped = false;
            while !stopped {
                tokio::select! {
                    biased;
                    chunk = audio_rx.recv() => {
                        match chunk {
                            Some(bytes) => {
                                if sent + bytes.len() > max_bytes {
                                    pending = Some(bytes);
                                    break;
                                }
                                sent += bytes.len();
                                keep_tail(&mut audio_tail, &bytes, overlap_bytes);
                                if body_tx.send(Ok(Bytes::from(bytes))).await.is_err() {
                                    stopped = true;
                                }
                            }
                            None => stopped = true,
                        }
                    }
                    changed = segment_stop.changed() => {
                        if changed.is_err() || *segment_stop.borrow() {
                            stopped = true;
                        }
                    }
                }
            }
            let _ = body_tx.send(Ok(Bytes::from(tail.clone()))).await;
            stopped
        };
        let stopped = pump.await;
        drop(body_tx);
        let response = send_task
            .await
            .map_err(|error| format!("Sync live task failed: {error}"))?
            .map_err(|error| format!("Sync live request failed: {error}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| format!("Could not read the Sync live response: {error}"))?;
        if !status.is_success() {
            return Err(format!(
                "AssemblyAI Sync live {status}: {}",
                api_message(&text)
            ));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| format!("AssemblyAI sent invalid JSON: {error}"))?;
        let transcript = value
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if !transcript.is_empty() {
            transcripts.push(transcript.to_string());
        }
        if stopped || *stop_rx.borrow() {
            break;
        }
        // The segment hit the audio cap; start a fresh request and carry on.
        // Re-send the last second so a word cut by the boundary is complete in
        // the next segment, and de-duplicate it when joining the transcripts.
        overlap = Some(std::mem::take(&mut audio_tail));
    }
    let text = transcripts.iter().fold(String::new(), |acc, next| {
        join_segment_transcripts(&acc, next)
    });
    if text.is_empty() {
        Err("No speech was detected".into())
    } else {
        Ok(text)
    }
}
/// Keep only the last `limit` bytes of audio sent to a segment, for the
/// rollover overlap.
fn keep_tail(tail: &mut Vec<u8>, bytes: &[u8], limit: usize) {
    if limit == 0 {
        tail.clear();
        return;
    }
    if bytes.len() >= limit {
        tail.clear();
        tail.extend_from_slice(&bytes[bytes.len() - limit..]);
        return;
    }
    tail.extend_from_slice(bytes);
    if tail.len() > limit {
        let excess = tail.len() - limit;
        tail.drain(..excess);
    }
}

fn normalize_word(word: &str) -> String {
    word.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Join two live segments. The second segment re-sends the last second of
/// audio, so its transcript starts with words the first one already produced.
/// Remove that overlap, and when the cut fell inside a word, let the complete
/// word from the second segment replace the fragment at the end of the first.
fn join_segment_transcripts(previous: &str, next: &str) -> String {
    let previous = previous.trim();
    let next = next.trim();
    if previous.is_empty() {
        return next.to_string();
    }
    if next.is_empty() {
        return previous.to_string();
    }
    let previous_words: Vec<&str> = previous.split_whitespace().collect();
    let next_words: Vec<&str> = next.split_whitespace().collect();
    let previous_norm: Vec<String> = previous_words
        .iter()
        .map(|word| normalize_word(word))
        .collect();
    let next_norm: Vec<String> = next_words.iter().map(|word| normalize_word(word)).collect();
    let max = previous_words.len().min(next_words.len()).min(40);

    // The overlap began inside an earlier word, so the second segment starts
    // with only its tail ("AssemblyAI for now" | "AI for now"). Drop the tail
    // only when the words after it line up with the rest of the first
    // segment; that avoids eating a real word such as "is" after "analysis".
    if next_norm.len() >= 2 && next_norm[0].len() >= 2 {
        let tail = &next_norm[0];
        for index in 0..previous_norm.len() {
            let word = &previous_norm[index];
            let remaining = previous_norm.len() - index - 1;
            if remaining >= 1
                && word.len() > tail.len()
                && word.ends_with(tail.as_str())
                && next_norm.len() > remaining
                && previous_norm[index + 1..] == next_norm[1..=remaining]
            {
                let rest = next_words[1..].join(" ");
                return join_segment_transcripts(previous, &rest);
            }
        }
    }

    // Complete words repeated because of the overlap: keep the first copy.
    for k in (1..=max).rev() {
        if previous_norm[previous_words.len() - k..] == next_norm[..k] {
            return format!("{} {}", previous, next_words[k..].join(" "))
                .trim()
                .to_string();
        }
    }

    // A word was cut at the boundary. The next segment contains the words
    // before it plus the full word, so drop the fragment (and the duplicated
    // run before it) from the first segment and keep the next one whole.
    for k in (1..=max).rev() {
        let fragment = &previous_norm[previous_words.len() - 1];
        if fragment.len() < 3 {
            continue;
        }
        if k == 1 {
            if next_norm[0].starts_with(fragment) && next_norm[0].len() > fragment.len() {
                return format!(
                    "{} {}",
                    previous_words[..previous_words.len() - 1].join(" "),
                    next
                )
                .trim()
                .to_string();
            }
        } else if previous_norm[previous_words.len() - k..previous_words.len() - 1]
            == next_norm[..k - 1]
            && next_norm[k - 1].starts_with(fragment)
            && next_norm[k - 1].len() > fragment.len()
        {
            return format!(
                "{} {}",
                previous_words[..previous_words.len() - k].join(" "),
                next
            )
            .trim()
            .to_string();
        }
    }
    format!("{previous} {next}")
}

fn sync_config(config: &SttConfig, keyterms: &[String]) -> Result<String, String> {
    let mut value = serde_json::json!({
        "sample_rate": config.sample_rate,
        "channels": 1,
        "prompt": config.prompt,
        "timestamps": false,
    });
    if !config.language_codes.is_empty() {
        value["language_codes"] = serde_json::json!(config.language_codes);
    }
    let terms = clean_keyterms(keyterms, config.keyterms_limit);
    if !terms.is_empty() {
        value["keyterms_prompt"] = serde_json::json!(terms);
    }
    serde_json::to_string(&value).map_err(|error| error.to_string())
}
fn boundary() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let counter = BOUNDARY_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("ray-{nanos:x}-{counter:x}")
}
fn api_message(text: &str) -> String {
    let trimmed = text.trim();
    serde_json::from_str::<Value>(trimmed)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| {
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .or_else(|| error.as_str())
                })
                .or_else(|| value.get("message").and_then(Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_else(|| trimmed.chars().take(300).collect())
}
// ---------------------------------------------------------------------------
// Universal Streaming over WebSocket (alternative)
// ---------------------------------------------------------------------------
pub struct StreamSession {
    pub audio_tx: mpsc::UnboundedSender<Vec<u8>>,
    stop_tx: watch::Sender<bool>,
    task: JoinHandle<Result<String, String>>,
}
impl StreamSession {
    pub async fn finish(self, timeout: Duration) -> Result<String, String> {
        let _ = self.stop_tx.send(true);
        let mut task = self.task;
        tokio::select! {
            result = &mut task => match result {
                Ok(result) => result,
                Err(error) => Err(format!("Streaming task failed: {error}")),
            },
            _ = tokio::time::sleep(timeout) => {
                task.abort();
                Err("Streaming did not finish in time".into())
            }
        }
    }
    pub fn abort(self) {
        let _ = self.stop_tx.send(true);
        self.task.abort();
    }
}
pub fn spawn_stream(api_key: String, config: SttConfig, keyterms: Vec<String>) -> StreamSession {
    let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = watch::channel(false);
    let task =
        tokio::spawn(
            async move { run_stream(&api_key, &config, &keyterms, audio_rx, stop_rx).await },
        );
    StreamSession {
        audio_tx,
        stop_tx,
        task,
    }
}
async fn run_stream(
    api_key: &str,
    config: &SttConfig,
    keyterms: &[String],
    mut audio_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    mut stop_rx: watch::Receiver<bool>,
) -> Result<String, String> {
    let url = stream_url(config, keyterms)?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("Build streaming request: {error}"))?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(api_key).map_err(|_| "The AssemblyAI key has invalid characters")?,
    );
    request
        .headers_mut()
        .insert("User-Agent", HeaderValue::from_static("Ray/0.1 (Windows)"));
    let connect_timeout = Duration::from_millis(config.connect_timeout_ms.max(1_000));
    let (mut socket, _) =
        tokio::time::timeout(connect_timeout, tokio_tungstenite::connect_async(request))
            .await
            .map_err(|_| "AssemblyAI streaming connection timed out".to_string())?
            .map_err(|error| format!("AssemblyAI streaming connection failed: {error}"))?;
    // Wait for Begin so an auth/parameter error surfaces before we record.
    let begin_deadline = tokio::time::Instant::now() + connect_timeout;
    loop {
        match tokio::time::timeout_at(begin_deadline, socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let value: Value = serde_json::from_str(text.as_str())
                    .map_err(|error| format!("AssemblyAI sent invalid JSON: {error}"))?;
                match value.get("type").and_then(Value::as_str) {
                    Some("Begin") => break,
                    Some("Error") => return Err(stream_error(&value)),
                    _ => continue,
                }
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => {
                return Err("AssemblyAI closed the stream before it began".into())
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(error))) => return Err(format!("AssemblyAI streaming error: {error}")),
            Err(_) => return Err("AssemblyAI did not acknowledge the stream in time".into()),
        }
    }
    let mut finals: Vec<String> = Vec::new();
    let mut partial = String::new();
    let mut stop_requested = false;
    let mut audio_closed = false;
    while !stop_requested {
        tokio::select! {
            changed = stop_rx.changed() => {
                let _ = changed;
                stop_requested = true;
            }
            message = socket.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if matches!(
                            handle_text(text.as_str(), &mut finals, &mut partial)?,
                            MessageEffect::Ended
                        ) {
                            let text = join_transcript(&finals, &partial);
                            return if text.is_empty() {
                                Err("AssemblyAI ended the stream without a transcript".into())
                            } else {
                                Ok(text)
                            };
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        let text = join_transcript(&finals, &partial);
                        return if text.is_empty() {
                            Err("AssemblyAI closed the stream without a transcript".into())
                        } else {
                            Ok(text)
                        };
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        let text = join_transcript(&finals, &partial);
                        return if text.is_empty() {
                            Err(format!("AssemblyAI streaming error: {error}"))
                        } else {
                            Ok(text)
                        };
                    }
                }
            }
            chunk = audio_rx.recv(), if !audio_closed => {
                match chunk {
                    Some(bytes) => {
                        if !bytes.is_empty() {
                            socket
                                .send(Message::binary(bytes))
                                .await
                                .map_err(|error| format!("Send audio: {error}"))?;
                        }
                    }
                    None => audio_closed = true,
                }
            }
        }
    }
    while let Ok(bytes) = audio_rx.try_recv() {
        if !bytes.is_empty() {
            let _ = socket.send(Message::binary(bytes)).await;
        }
    }
    let _ = socket
        .send(Message::text(r#"{"type":"ForceEndpoint"}"#))
        .await;
    let final_deadline =
        tokio::time::Instant::now() + Duration::from_millis(config.force_endpoint_timeout_ms);
    loop {
        match tokio::time::timeout_at(final_deadline, socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let value: Value = match serde_json::from_str(text.as_str()) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if value.get("type").and_then(Value::as_str) == Some("Turn") {
                    let ended = value
                        .get("end_of_turn")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    absorb_turn(&value, &mut finals, &mut partial);
                    if ended {
                        break;
                    }
                }
            }
            Ok(Some(Ok(Message::Ping(payload)))) => {
                let _ = socket.send(Message::Pong(payload)).await;
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => break,
            Err(_) => break,
        }
    }
    let _ = socket.send(Message::text(r#"{"type":"Terminate"}"#)).await;
    let terminate_deadline =
        tokio::time::Instant::now() + Duration::from_millis(config.terminate_timeout_ms);
    loop {
        match tokio::time::timeout_at(terminate_deadline, socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<Value>(text.as_str()) {
                    match value.get("type").and_then(Value::as_str) {
                        Some("Turn") => absorb_turn(&value, &mut finals, &mut partial),
                        Some("Termination") | Some("Error") => break,
                        _ => {}
                    }
                }
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
            Ok(Some(Ok(Message::Ping(payload)))) => {
                let _ = socket.send(Message::Pong(payload)).await;
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Err(_) => break,
        }
    }
    let _ = socket.close(None).await;
    let text = join_transcript(&finals, &partial);
    if text.is_empty() {
        Err("No speech was detected".into())
    } else {
        Ok(text)
    }
}
enum MessageEffect {
    None,
    Ended,
}
fn handle_text(
    text: &str,
    finals: &mut Vec<String>,
    partial: &mut String,
) -> Result<MessageEffect, String> {
    let value: Value = serde_json::from_str(text)
        .map_err(|error| format!("AssemblyAI sent invalid JSON: {error}"))?;
    match value.get("type").and_then(Value::as_str) {
        Some("Turn") => {
            absorb_turn(&value, finals, partial);
            Ok(MessageEffect::None)
        }
        Some("Error") => Err(stream_error(&value)),
        Some("Termination") => Ok(MessageEffect::Ended),
        _ => Ok(MessageEffect::None),
    }
}
fn absorb_turn(value: &Value, finals: &mut Vec<String>, partial: &mut String) {
    let transcript = value
        .get("transcript")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let ended = value
        .get("end_of_turn")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let formatted = value
        .get("turn_is_formatted")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if ended {
        if formatted {
            if !transcript.is_empty() && !finals.last().is_some_and(|last| last == &transcript) {
                finals.push(transcript);
            }
            partial.clear();
        } else if !transcript.is_empty() {
            *partial = transcript;
        }
    } else if !transcript.is_empty() {
        *partial = transcript;
    }
}
fn join_transcript(finals: &[String], partial: &str) -> String {
    let mut parts: Vec<&str> = finals
        .iter()
        .map(String::as_str)
        .filter(|part| !part.is_empty())
        .collect();
    let partial = partial.trim();
    if !partial.is_empty() && !parts.last().is_some_and(|last| *last == partial) {
        parts.push(partial);
    }
    parts.join(" ").trim().to_string()
}
fn stream_error(value: &Value) -> String {
    let code = value
        .get("error_code")
        .and_then(Value::as_i64)
        .map(|code| format!(" ({code})"))
        .unwrap_or_default();
    let message = value
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("unknown error");
    format!("AssemblyAI{code}: {message}")
}
fn stream_url(config: &SttConfig, keyterms: &[String]) -> Result<Url, String> {
    let mut url = Url::parse(WEBSOCKET_URL).map_err(|error| error.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("sample_rate", &config.sample_rate.to_string());
        query.append_pair("encoding", &config.encoding);
        query.append_pair("speech_model", &config.speech_model);
        query.append_pair(
            "format_turns",
            if config.format_turns { "true" } else { "false" },
        );
        query.append_pair("max_turn_silence", &config.max_turn_silence.to_string());
        query.append_pair(
            "end_of_turn_confidence_threshold",
            &config.end_of_turn_confidence_threshold.to_string(),
        );
        if !config.prompt.is_empty() {
            query.append_pair("prompt", &config.prompt);
        }
        if !config.language_codes.is_empty() {
            let languages =
                serde_json::to_string(&config.language_codes).map_err(|error| error.to_string())?;
            query.append_pair("language_codes", &languages);
        }
        let terms = clean_keyterms(keyterms, config.keyterms_limit);
        if !terms.is_empty() {
            query.append_pair(
                "keyterms_prompt",
                &serde_json::to_string(&terms).map_err(|error| error.to_string())?,
            );
        }
    }
    Ok(url)
}
pub fn clean_keyterms(terms: &[String], limit: usize) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for term in terms {
        let term = term.trim();
        if term.is_empty() || term.chars().count() > 50 {
            continue;
        }
        if seen.insert(term.to_lowercase()) {
            out.push(term.to_string());
        }
        if out.len() >= limit {
            break;
        }
    }
    out
}
// ---------------------------------------------------------------------------
// Batch fallback
// ---------------------------------------------------------------------------
#[derive(serde::Deserialize)]
struct UploadResponse {
    upload_url: String,
}
#[derive(serde::Deserialize)]
struct TranscriptResponse {
    id: String,
    status: String,
    text: Option<String>,
    error: Option<String>,
}
/// Sync batch first (fast, single multipart request), then the older
/// asynchronous v2 API if configured.
pub async fn transcribe_wav(
    http: &reqwest::Client,
    api_key: &str,
    keyterms: &[String],
    wav: Vec<u8>,
    config: &SttConfig,
) -> Result<String, String> {
    if wav.len() <= 44 {
        return Err("No audio was captured".into());
    }
    match transcribe_sync_batch(http, api_key, keyterms, wav.clone(), config).await {
        Ok(text) => Ok(text),
        Err(error) => {
            if !config.batch.v2_fallback {
                return Err(error);
            }
            eprintln!("[ray] Sync batch failed ({error}); trying v2 batch");
            transcribe_v2(http, api_key, keyterms, wav, config).await
        }
    }
}
async fn transcribe_sync_batch(
    http: &reqwest::Client,
    api_key: &str,
    keyterms: &[String],
    wav: Vec<u8>,
    config: &SttConfig,
) -> Result<String, String> {
    let boundary = boundary();
    let config_json = sync_config(config, keyterms)?;
    let mut body = Vec::with_capacity(wav.len() + 1024);
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"config\"\r\n\
             Content-Type: application/json\r\n\r\n{config_json}\r\n\
             --{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; \
             filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&wav);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = http
        .post(&config.batch.endpoint)
        .header("authorization", api_key)
        .header("X-AAI-Model", &config.batch.model)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .timeout(Duration::from_millis(config.batch.timeout_ms))
        .send()
        .await
        .map_err(|error| format!("Sync batch request failed: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Read Sync batch response: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "AssemblyAI Sync batch {status}: {}",
            api_message(&text)
        ));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("AssemblyAI sent invalid JSON: {error}"))?;
    value
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "AssemblyAI returned an empty transcript".into())
}
async fn transcribe_v2(
    http: &reqwest::Client,
    api_key: &str,
    keyterms: &[String],
    wav: Vec<u8>,
    config: &SttConfig,
) -> Result<String, String> {
    let upload = http
        .post(format!("{V2_URL}/upload"))
        .header("authorization", api_key)
        .header("content-type", "application/octet-stream")
        .body(wav)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|error| format!("Upload audio: {error}"))?
        .error_for_status()
        .map_err(|error| format!("AssemblyAI rejected the upload: {error}"))?
        .json::<UploadResponse>()
        .await
        .map_err(|error| format!("Read upload response: {error}"))?;
    let terms = clean_keyterms(keyterms, 1_000);
    let mut body = serde_json::json!({
        "audio_url": upload.upload_url,
        "speech_models": config.batch.speech_models,
        "punctuate": true,
        "format_text": true,
    });
    if !terms.is_empty() {
        body["keyterms_prompt"] = serde_json::json!(terms);
    }
    let created = http
        .post(format!("{V2_URL}/transcript"))
        .header("authorization", api_key)
        .json(&body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| format!("Create transcript: {error}"))?
        .error_for_status()
        .map_err(|error| format!("AssemblyAI rejected the transcript: {error}"))?
        .json::<TranscriptResponse>()
        .await
        .map_err(|error| format!("Read transcript response: {error}"))?;
    poll_transcript(http, api_key, &created, &config.batch).await
}
async fn poll_transcript(
    http: &reqwest::Client,
    api_key: &str,
    created: &TranscriptResponse,
    config: &BatchConfig,
) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(config.timeout_ms);
    let mut current = TranscriptResponse {
        id: created.id.clone(),
        status: created.status.clone(),
        text: None,
        error: None,
    };
    loop {
        match current.status.as_str() {
            "completed" => {
                return current
                    .text
                    .filter(|text| !text.trim().is_empty())
                    .map(|text| text.trim().to_string())
                    .ok_or_else(|| "AssemblyAI returned an empty transcript".into())
            }
            "error" => {
                return Err(format!(
                    "AssemblyAI transcription failed: {}",
                    current.error.unwrap_or_else(|| "unknown error".into())
                ))
            }
            _ => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("AssemblyAI transcription timed out".into());
        }
        tokio::time::sleep(Duration::from_millis(config.poll_interval_ms.max(250))).await;
        current = http
            .get(format!("{V2_URL}/transcript/{}", created.id))
            .header("authorization", api_key)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|error| format!("Poll transcript: {error}"))?
            .error_for_status()
            .map_err(|error| format!("AssemblyAI poll failed: {error}"))?
            .json::<TranscriptResponse>()
            .await
            .map_err(|error| format!("Read poll response: {error}"))?;
    }
}
/// Wrap 16-bit mono samples in a minimal WAV container.
pub fn wav_from_pcm16(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wav_header_is_well_formed() {
        let wav = wav_from_pcm16(&[1, -1, 0, 100], 16_000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 44);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 8);
        assert_eq!(wav.len(), 52);
    }
    #[test]
    fn joins_final_turns_and_partial() {
        let finals = vec!["Hello there.".to_string(), "This is Ray.".to_string()];
        assert_eq!(
            join_transcript(&finals, "And a partial"),
            "Hello there. This is Ray. And a partial"
        );
    }
    #[test]
    fn rollover_join_removes_repeated_overlap_words() {
        assert_eq!(
            join_segment_transcripts(
                "We should ship the update.",
                "ship the update. Then tell Arham."
            ),
            "We should ship the update. Then tell Arham."
        );
        assert_eq!(
            join_segment_transcripts("Three things.", "Three things. First is the API."),
            "Three things. First is the API."
        );
    }

    #[test]
    fn rollover_join_repairs_a_word_cut_at_the_boundary() {
        assert_eq!(
            join_segment_transcripts("We should ship the workfl", "workflow tomorrow."),
            "We should ship the workflow tomorrow."
        );
        assert_eq!(
            join_segment_transcripts("we should ship the workfl", "ship the workflow tomorrow."),
            "we should ship the workflow tomorrow."
        );
        assert_eq!(
            join_segment_transcripts("I'll ask Kuber", "Kubernetes about it."),
            "I'll ask Kubernetes about it."
        );
    }

    #[test]
    fn rollover_join_drops_a_tail_of_the_last_word() {
        assert_eq!(
            join_segment_transcripts(
                "The transcription stays on AssemblyAI for now.",
                "AI for now, but we'll add an adapter."
            ),
            "The transcription stays on AssemblyAI for now. but we'll add an adapter."
        );
        // A real word that merely looks like a suffix must be kept.
        assert_eq!(
            join_segment_transcripts("The analysis", "is clear."),
            "The analysis is clear."
        );
    }

    #[test]
    fn rollover_join_keeps_independent_segments() {
        assert_eq!(
            join_segment_transcripts("First part ends here.", "Second part starts here."),
            "First part ends here. Second part starts here."
        );
    }

    #[test]
    fn rollover_tail_keeps_only_the_last_bytes() {
        let mut tail = Vec::new();
        keep_tail(&mut tail, &[1, 2, 3], 4);
        keep_tail(&mut tail, &[4, 5, 6], 4);
        assert_eq!(tail, vec![3, 4, 5, 6]);
        keep_tail(&mut tail, &[7, 8, 9, 10, 11], 4);
        assert_eq!(tail, vec![8, 9, 10, 11]);
    }

    #[test]
    fn keyterms_are_trimmed_deduped_and_capped() {
        let terms = vec![
            "  Ray ".into(),
            "ray".into(),
            "Helion HQ".into(),
            "x".repeat(51),
        ];
        let cleaned = clean_keyterms(&terms, 10);
        assert_eq!(cleaned, vec!["Ray".to_string(), "Helion HQ".to_string()]);
    }
}
