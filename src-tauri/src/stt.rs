//! Speech-to-text through the Ray API.
//!
//! Primary: Sync live (`POST {api}/v1/stt/sync-live`), a chunked multipart
//! request whose config part is sent up front and whose audio part is streamed
//! while the user speaks. The Worker proxies it to AssemblyAI with the
//! server-side key, so stopping only leaves the tail and final decode (~0.5 s).
//!
//! Fallbacks, using the locally buffered WAV: Sync batch
//! (`POST {api}/v1/stt/sync`), then the Worker-side v2 upload/poll proxy
//! (`POST {api}/v1/stt/batch`, which returns `{ text }`).
use crate::api::{self, ApiError};
use crate::config::SttConfig;
use base64::Engine;
use bytes::Bytes;
use serde_json::Value;
use std::io;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

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

/// A failed live request, plus any segment transcripts that finished before
/// the failure. A quota error on a later rollover segment must never discard
/// the segments the user already spoke (review decision 5).
#[derive(Debug)]
pub struct LiveError {
    pub error: ApiError,
    pub partial: Option<String>,
}

impl LiveError {
    fn new(error: ApiError, transcripts: &[String]) -> Self {
        Self {
            error,
            partial: partial_text(transcripts),
        }
    }

    pub fn is_fatal(&self) -> bool {
        self.error.is_fatal()
    }
}

impl std::fmt::Display for LiveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.error, formatter)
    }
}

impl std::error::Error for LiveError {}

/// Shared progress of a live session: the end of the PCM already sent in
/// successfully decoded segments (so the Worker has counted it), and the
/// transcript produced so far. The batch fallback starts after the covered
/// audio and joins this text, so a live failure does not transcribe (and
/// count) the same audio twice (review decision on quota accuracy).
#[derive(Debug, Default)]
pub struct LiveProgress {
    covered_bytes: AtomicUsize,
    text: Mutex<String>,
}

impl LiveProgress {
    /// PCM bytes covered by completed live segments. The next batch fallback
    /// must start at this byte offset (always even: PCM16).
    pub fn covered_bytes(&self) -> usize {
        self.covered_bytes.load(Ordering::SeqCst)
    }

    fn partial_text(&self) -> Option<String> {
        let text = self
            .text
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .trim()
            .to_string();
        (!text.is_empty()).then_some(text)
    }

    fn record(&self, covered_bytes: usize, text: &str) {
        self.covered_bytes.store(covered_bytes, Ordering::SeqCst);
        *self.text.lock().unwrap_or_else(|error| error.into_inner()) = text.to_string();
    }
}

/// One live transcription session (Sync live is the only supported protocol).
pub struct LiveSession {
    pub audio_tx: mpsc::UnboundedSender<Vec<u8>>,
    stop_tx: watch::Sender<bool>,
    task: JoinHandle<Result<String, LiveError>>,
    progress: Arc<LiveProgress>,
}

impl LiveSession {
    pub fn audio_sender(&self) -> mpsc::UnboundedSender<Vec<u8>> {
        self.audio_tx.clone()
    }

    /// Progress shared with the live task. Read it after `finish` fails (or
    /// times out) to find the audio the Worker already transcribed.
    pub fn progress_handle(&self) -> Arc<LiveProgress> {
        self.progress.clone()
    }

    pub async fn finish(self, timeout: Duration) -> Result<String, LiveError> {
        let _ = self.stop_tx.send(true);
        let progress = self.progress.clone();
        let mut task = self.task;
        tokio::select! {
            result = &mut task => match result {
                Ok(result) => result,
                Err(error) => Err(LiveError {
                    error: ApiError::other(format!("Sync live task failed: {error}")),
                    partial: progress.partial_text(),
                }),
            },
            _ = tokio::time::sleep(timeout) => {
                // Do not leave a stalled upload running: it would hold the
                // connection and its 300 s request timeout while the batch
                // fallback already has the audio.
                task.abort();
                Err(LiveError {
                    error: ApiError::other("Sync live did not finish in time"),
                    partial: progress.partial_text(),
                })
            }
        }
    }

    pub fn abort(self) {
        let _ = self.stop_tx.send(true);
        self.task.abort();
    }
}

pub fn spawn_live(
    api_base: &str,
    token: &str,
    config: SttConfig,
    keyterms: Vec<String>,
    http: reqwest::Client,
) -> LiveSession {
    let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = watch::channel(false);
    let base = api_base.to_string();
    let token = token.to_string();
    let progress = Arc::new(LiveProgress::default());
    let task_progress = progress.clone();
    let task = tokio::spawn(async move {
        run_sync_live(
            &base,
            &token,
            &config,
            &keyterms,
            audio_rx,
            stop_rx,
            http,
            task_progress,
        )
        .await
    });
    LiveSession {
        audio_tx,
        stop_tx,
        task,
        progress,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_sync_live(
    api_base: &str,
    token: &str,
    config: &SttConfig,
    keyterms: &[String],
    mut audio_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    stop_rx: watch::Receiver<bool>,
    http: reqwest::Client,
    progress: Arc<LiveProgress>,
) -> Result<String, LiveError> {
    // Stay a little under the endpoint's 120 s audio cap per request.
    let segment_seconds = config.sync_live.max_audio_seconds.saturating_sub(2).max(1);
    let max_bytes = (segment_seconds * config.sample_rate as u64 * 2) as usize;
    let endpoint = api::endpoint(api_base, "/v1/stt/sync-live");
    let mut transcripts: Vec<String> = Vec::new();
    let mut pending: Option<Vec<u8>> = None;
    // A hard 118 s cut can land inside a word. Re-send the last second of the
    // finished segment at the start of the next one, then remove the repeated
    // words when joining, so no word is lost or duplicated.
    let overlap_bytes = (config.sample_rate as usize * 2).min(max_bytes / 4);
    let mut overlap: Option<Vec<u8>> = None;
    let mut audio_tail: Vec<u8> = Vec::new();
    // End of the audio covered by completed segments. The overlap is re-sent
    // but already counted, so it does not move this offset forward.
    let mut covered = 0usize;
    loop {
        let boundary = boundary();
        let config_json =
            sync_config(config, keyterms).map_err(|error| LiveError::new(error, &transcripts))?;
        let head = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"config\"\r\nContent-Type: application/json\r\n\r\n{config_json}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"audio.pcm\"\r\nContent-Type: audio/pcm\r\n\r\n"
        );
        let tail = format!("\r\n--{boundary}--\r\n");
        let (body_tx, body_rx) = mpsc::channel::<Result<Bytes, io::Error>>(128);
        if body_tx.send(Ok(Bytes::from(head))).await.is_err() {
            return Err(LiveError::new(
                ApiError::other("Could not start the upload"),
                &transcripts,
            ));
        }
        let mut segment_stop = stop_rx.clone();
        let request = http
            .post(&endpoint)
            .header("authorization", api::authorization(token))
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
        let overlap_len = overlap.as_ref().map_or(0, Vec::len);
        let segment_start = covered.saturating_sub(overlap_len);
        let mut sent = 0usize;
        let pump = async {
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
            .map_err(|error| {
                LiveError::new(
                    ApiError::other(format!("Sync live task failed: {error}")),
                    &transcripts,
                )
            })?
            .map_err(|error| {
                LiveError::new(
                    ApiError::other(format!("Sync live request failed: {error}")),
                    &transcripts,
                )
            })?;
        let status = response.status();
        let text = response.text().await.map_err(|error| {
            LiveError::new(
                ApiError::other(format!("Could not read the Sync live response: {error}")),
                &transcripts,
            )
        })?;
        if !status.is_success() {
            return Err(LiveError::new(
                response_error("Sync live", status.as_u16(), &text),
                &transcripts,
            ));
        }
        let value: Value = serde_json::from_str(&text).map_err(|error| {
            LiveError::new(
                ApiError::other(format!("Ray sent invalid JSON: {error}")),
                &transcripts,
            )
        })?;
        let transcript = value
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if !transcript.is_empty() {
            transcripts.push(transcript.to_string());
        }
        // This segment's audio was transcribed and counted by the Worker, so
        // the batch fallback must start after it. Record the joined text too:
        // a client-side timeout still returns what was already transcribed.
        let joined = transcripts.iter().fold(String::new(), |acc, next| {
            join_segment_transcripts(&acc, next)
        });
        covered = segment_start + sent;
        progress.record(covered, &joined);
        // Only finish when the pump itself saw the stop. If the stop arrived
        // while this segment was waiting for its response, `pending` and the
        // queued audio still have to go out in another segment.
        if stopped {
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
        Err(LiveError {
            error: ApiError::other("No speech was detected"),
            partial: None,
        })
    } else {
        Ok(text)
    }
}

/// Join every completed live segment, returning `None` for silence. Kept
/// separate from `run_sync_live` so the "keep what was transcribed" rule can
/// be unit-tested without a network.
fn partial_text(transcripts: &[String]) -> Option<String> {
    let text = transcripts.iter().fold(String::new(), |acc, next| {
        join_segment_transcripts(&acc, next)
    });
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
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
pub(crate) fn join_segment_transcripts(previous: &str, next: &str) -> String {
    join_transcripts(previous, next, true)
}

/// Join live text with the batch fallback. The batch starts at the end of the
/// PCM covered by completed live segments, so the two transcripts do not
/// overlap: a suffix/prefix match is a word the user really repeated across
/// the split and must be kept. Only a word cut at the split is repaired.
pub(crate) fn join_batch_transcripts(previous: &str, next: &str) -> String {
    join_transcripts(previous, next, false)
}

fn join_transcripts(previous: &str, next: &str, overlap: bool) -> String {
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

    if overlap {
        // The overlap began inside an earlier word, so the second segment
        // starts with only its tail ("AssemblyAI for now" | "AI for now").
        // Drop the tail only when the words after it line up with the rest of
        // the first segment; that avoids eating a real word such as "is"
        // after "analysis".
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
    }

    // A word was cut at the boundary. At a live rollover the next segment
    // contains the words before it plus the full word, so drop the fragment
    // (and the duplicated run before it) from the first segment and keep the
    // next one whole. At a batch boundary there is no repeated run, so only
    // the single cut word is repaired.
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
        } else if overlap
            && previous_norm[previous_words.len() - k..previous_words.len() - 1]
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

fn sync_config(config: &SttConfig, keyterms: &[String]) -> Result<String, ApiError> {
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
    serde_json::to_string(&value).map_err(|error| ApiError::other(error.to_string()))
}

fn boundary() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let counter = BOUNDARY_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("ray-{nanos:x}-{counter:x}")
}

/// Turn a non-success response into a typed quota/auth error when it is one,
/// otherwise a normal error the caller may fall back from.
fn response_error(label: &str, status: u16, body: &str) -> ApiError {
    if let Some(error) = ApiError::from_response(status, body) {
        return error;
    }
    ApiError::other(format!(
        "Ray {label} {status}: {}",
        api::message_from_body(body)
    ))
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

/// Base64url(JSON array), the header format the Worker expects because headers
/// cannot carry arbitrary Unicode.
fn keyterms_header(terms: &[String]) -> Option<String> {
    let terms = clean_keyterms(terms, 1_000);
    if terms.is_empty() {
        return None;
    }
    let json = serde_json::to_string(&terms).ok()?;
    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json.as_bytes()))
}

// ---------------------------------------------------------------------------
// Batch fallbacks
// ---------------------------------------------------------------------------

/// Worst case for the Worker-side v2 fallback: 60 s to upload the WAV, 20 s
/// to create the transcript, then up to 45 s of polling.
pub const RAY_BATCH_UPLOAD_TIMEOUT: Duration = Duration::from_secs(60);
pub const RAY_BATCH_CREATE_TIMEOUT: Duration = Duration::from_secs(20);
pub const RAY_BATCH_POLL_TIMEOUT: Duration = Duration::from_secs(45);
/// Slack on top of both sequential requests for scheduling and response reads.
pub const BATCH_BUDGET_MARGIN: Duration = Duration::from_secs(15);
/// The request timeout for `/v1/stt/batch` itself. It must cover the Worker's
/// whole upload → create → poll sequence, not just one HTTP hop.
pub const RAY_BATCH_REQUEST_MARGIN: Duration = Duration::from_secs(5);

pub fn ray_batch_timeout() -> Duration {
    RAY_BATCH_UPLOAD_TIMEOUT + RAY_BATCH_CREATE_TIMEOUT + RAY_BATCH_POLL_TIMEOUT
}

/// The longest `transcribe_wav` can legitimately take: the Sync batch timeout
/// plus the Worker's whole v2 fallback worst case, plus one margin. The two
/// fallbacks run sequentially, so a budget that only covered one of them would
/// abandon the second request while it was still healthy.
pub fn batch_time_budget(config: &SttConfig) -> Duration {
    Duration::from_millis(config.batch.timeout_ms) + ray_batch_timeout() + BATCH_BUDGET_MARGIN
}

/// Sync batch first (fast, single multipart request), then the Worker-side v2
/// proxy if the first request fails for a non-quota reason.
pub async fn transcribe_wav(
    http: &reqwest::Client,
    api_base: &str,
    token: &str,
    keyterms: &[String],
    wav: Vec<u8>,
    config: &SttConfig,
) -> Result<String, ApiError> {
    if wav.len() <= 44 {
        return Err(ApiError::other("No audio was captured"));
    }
    match transcribe_sync_batch(http, api_base, token, keyterms, wav.clone(), config).await {
        Ok(text) => Ok(text),
        Err(error) if error.is_fatal() => Err(error),
        Err(error) => {
            eprintln!("[ray] Sync batch failed ({error}); trying Ray v2 batch");
            transcribe_ray_batch(http, api_base, token, keyterms, wav, config).await
        }
    }
}

async fn transcribe_sync_batch(
    http: &reqwest::Client,
    api_base: &str,
    token: &str,
    keyterms: &[String],
    wav: Vec<u8>,
    config: &SttConfig,
) -> Result<String, ApiError> {
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
        .post(api::endpoint(api_base, "/v1/stt/sync"))
        .header("authorization", api::authorization(token))
        .header("X-AAI-Model", &config.batch.model)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .timeout(Duration::from_millis(config.batch.timeout_ms))
        .send()
        .await
        .map_err(|error| ApiError::other(format!("Sync batch request failed: {error}")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| ApiError::other(format!("Read Sync batch response: {error}")))?;
    if !status.is_success() {
        return Err(response_error("Sync batch", status.as_u16(), &text));
    }
    parse_text(&text, "Ray returned an empty transcript")
}

async fn transcribe_ray_batch(
    http: &reqwest::Client,
    api_base: &str,
    token: &str,
    keyterms: &[String],
    wav: Vec<u8>,
    config: &SttConfig,
) -> Result<String, ApiError> {
    let mut request = http
        .post(api::endpoint(api_base, "/v1/stt/batch"))
        .header("authorization", api::authorization(token))
        .header("content-type", "audio/wav");
    if let Some(header) = keyterms_header(keyterms) {
        request = request.header("X-Ray-Keyterms", header);
    }
    if !config.batch.speech_models.is_empty() {
        request = request.header("X-Ray-Speech-Models", config.batch.speech_models.join(","));
    }
    // The Worker uploads, creates, and polls before answering; a 45 s client
    // timeout would cut off a healthy v2 transcription mid-poll.
    let response = request
        .body(wav)
        .timeout(ray_batch_timeout() + RAY_BATCH_REQUEST_MARGIN)
        .send()
        .await
        .map_err(|error| ApiError::other(format!("Batch request failed: {error}")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| ApiError::other(format!("Read batch response: {error}")))?;
    if !status.is_success() {
        return Err(response_error("batch", status.as_u16(), &text));
    }
    parse_text(&text, "Ray returned an empty transcript")
}

fn parse_text(body: &str, empty: &str) -> Result<String, ApiError> {
    let value: Value = serde_json::from_str(body)
        .map_err(|error| ApiError::other(format!("Ray sent invalid JSON: {error}")))?;
    value
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| ApiError::other(empty))
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
    fn batch_join_keeps_a_word_repeated_across_the_split() {
        // The batch starts where live stopped, so there is no overlap: the
        // repeated "said" was really spoken and must not be de-duplicated.
        assert_eq!(
            join_batch_transcripts("I said", "said we should ship it."),
            "I said said we should ship it."
        );
        // The overlap-only tail repair must not run at a batch boundary.
        assert_eq!(
            join_batch_transcripts(
                "The transcription stays on AssemblyAI for now.",
                "AI for now, but we'll add an adapter."
            ),
            "The transcription stays on AssemblyAI for now. AI for now, but we'll add an adapter."
        );
    }

    #[test]
    fn batch_join_repairs_a_word_cut_at_the_split() {
        assert_eq!(
            join_batch_transcripts("We should ship the workfl", "workflow tomorrow."),
            "We should ship the workflow tomorrow."
        );
        assert_eq!(
            join_batch_transcripts("First part ends here.", "Second part starts here."),
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

    #[test]
    fn keyterms_header_is_base64url_json() {
        let header = keyterms_header(&["Ray".into(), "Helion HQ".into()]).expect("header");
        assert!(!header.contains('='), "base64url must be unpadded");
        assert!(!header.contains('+') && !header.contains('/'));
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(header)
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Vec<String>>(&decoded).unwrap(),
            vec!["Ray".to_string(), "Helion HQ".to_string()]
        );
        assert_eq!(keyterms_header(&[]), None);
    }

    #[test]
    fn quota_responses_are_fatal_and_other_failures_are_not() {
        let quota = response_error("Sync live", 402, r#"{"error":"quota_exceeded"}"#);
        assert!(quota.is_fatal());
        let fair = response_error("Sync live", 429, r#"{"error":"fair_use"}"#);
        assert!(fair.is_fatal());
        let auth = response_error("Sync live", 401, r#"{"error":"unauthorized"}"#);
        assert!(auth.is_fatal());
        // Upstream failures are mapped by the Worker to these codes and must
        // keep their normal fallback path.
        for (status, body) in [
            (502, r#"{"error":"upstream_error"}"#),
            (503, r#"{"error":"upstream_busy"}"#),
            (429, r#"{"error":"too_many_requests"}"#),
            (403, r#"{"error":"no_cleanup_grant"}"#),
            (401, "not a Ray error"),
        ] {
            let error = response_error("Sync live", status, body);
            assert!(!error.is_fatal(), "{status} {body} must not be fatal");
        }
        let server = response_error("Sync live", 500, "boom");
        assert!(!server.is_fatal());
        assert!(server.to_string().contains("500"));
    }

    #[test]
    fn a_failed_rollover_segment_keeps_the_transcribed_segments() {
        // Decision 5: a quota error on a later live segment returns the text
        // that already exists instead of discarding the dictation.
        let transcripts = vec![
            "We should ship the update.".to_string(),
            "ship the update. Then tell Arham.".to_string(),
        ];
        let failure = LiveError::new(
            response_error("Sync live", 402, r#"{"error":"quota_exceeded"}"#),
            &transcripts,
        );
        assert!(failure.is_fatal());
        assert_eq!(
            failure.partial.as_deref(),
            Some("We should ship the update. Then tell Arham.")
        );
        // An upstream error also carries the partial text, but remains
        // non-fatal so the batch fallback is still tried first.
        let upstream = LiveError::new(
            response_error("Sync live", 502, r#"{"error":"upstream_error"}"#),
            &transcripts,
        );
        assert!(!upstream.is_fatal());
        assert!(upstream.partial.is_some());
        // No completed segment means there is nothing to preserve.
        assert_eq!(LiveError::new(ApiError::other("boom"), &[]).partial, None);
    }

    #[test]
    fn batch_budget_covers_both_sequential_fallbacks() {
        let config = SttConfig::default();
        let expected = Duration::from_millis(config.batch.timeout_ms)
            + Duration::from_secs(60 + 20 + 45)
            + BATCH_BUDGET_MARGIN;
        assert_eq!(batch_time_budget(&config), expected);
        // The budget must exceed Sync batch plus the entire v2 worst case.
        assert!(
            batch_time_budget(&config)
                > Duration::from_millis(config.batch.timeout_ms) + ray_batch_timeout()
        );
        // `/v1/stt/batch`'s own request timeout matches the Worker worst case.
        assert_eq!(ray_batch_timeout(), Duration::from_secs(125));
        assert!(ray_batch_timeout() + RAY_BATCH_REQUEST_MARGIN > ray_batch_timeout());
    }
}
