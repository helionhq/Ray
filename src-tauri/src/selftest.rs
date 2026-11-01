//! `ray --selftest <file.wav>` / `ray --selftest-stream <file.wav>`
//!
//! Headless verification of the real pipeline against the real APIs. Reads a
//! 16 kHz mono PCM16 WAV, transcribes it through the shipping code path, runs
//! cleanup, and prints both results. Keys come from Windows Credential Manager
//! or the environment; nothing is compiled in.

use std::time::{Duration, Instant};

use crate::config::{self, PipelineConfig};
use crate::{audio, cleanup, secrets, stt};

pub fn run_selftest(path: &str, streaming: bool) -> i32 {
    run_selftest_with(path, streaming, false)
}

/// `--selftest-resample <file.wav>`: run any sample rate through the real
/// microphone resampler first, then the normal STT → cleanup path.
pub fn run_selftest_resampled(path: &str, streaming: bool) -> i32 {
    run_selftest_with(path, streaming, true)
}

fn run_selftest_with(path: &str, streaming: bool, resample: bool) -> i32 {
    let mut wav = match read_wav(path) {
        Ok(wav) => wav,
        Err(error) => {
            eprintln!("[selftest] {error}");
            return 2;
        }
    };
    if wav.sample_rate != 16_000 {
        if !resample {
            eprintln!(
                "[selftest] Expected 16 kHz audio, got {} Hz. Use --selftest-resample to run it through the capture resampler.",
                wav.sample_rate
            );
            return 2;
        }
        let original_rate = wav.sample_rate;
        let original_len = wav.samples.len();
        wav.samples = audio::resample_pcm16(&wav.samples, original_rate, 16_000);
        wav.sample_rate = 16_000;
        println!(
            "[selftest] resampled {} Hz -> 16000 Hz through audio.rs ({} -> {} samples)",
            original_rate,
            original_len,
            wav.samples.len()
        );
    } else if resample {
        println!("[selftest] input was already 16 kHz; the resampler is a no-op");
    }
    let key = secrets::get(secrets::ASSEMBLYAI);
    let Some(api_key) = key else {
        eprintln!("[selftest] ASSEMBLYAI_API_KEY is not set (environment or Credential Manager)");
        return 2;
    };
    let mut config = PipelineConfig::default();
    if let Ok(mode) = std::env::var("RAY_STT_MODE") {
        if !mode.trim().is_empty() {
            config.stt.mode = mode.trim().to_string();
        }
    }
    if std::env::var("RAY_TEST_FORCE_FALLBACK").is_ok() {
        if let Some(provider) = config.cleanup.providers.get_mut(0) {
            provider.base_url = "https://127.0.0.1:9/v1".into();
        }
    }
    let dictionary: Vec<String> = std::env::var("RAY_TEST_DICTIONARY")
        .ok()
        .map(|value| {
            value
                .split(',')
                .map(|term| term.trim().to_string())
                .filter(|term| !term.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let mut keyterms = dictionary.clone();
    for name in &config.known_names {
        if !keyterms.iter().any(|term| term.eq_ignore_ascii_case(name)) {
            keyterms.push(name.clone());
        }
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("[selftest] could not start the runtime: {error}");
            return 2;
        }
    };

    runtime.block_on(async move {
        let http = match reqwest::Client::builder()
            .user_agent("Ray/0.1 selftest")
            .pool_idle_timeout(Duration::from_secs(300))
            .build()
        {
            Ok(http) => http,
            Err(error) => {
                eprintln!("[selftest] http client: {error}");
                return 2;
            }
        };

        if std::env::var("RAY_TEST_WARM").is_ok() {
            // Simulates the app opening the cleanup connection while the user
            // is speaking: the request finishes long before the hotkey is up.
            let warm_started = Instant::now();
            cleanup::warm_connection(&http, &config.cleanup).await;
            println!(
                "[selftest] timing prewarm_ms={}",
                warm_started.elapsed().as_millis()
            );
        }

        println!(
            "[selftest] {} · {:.1}s · model {} · {}",
            path,
            wav.samples.len() as f32 / 16_000.0,
            if streaming {
                &config.stt.sync_live.model
            } else {
                &config.stt.batch.model
            },
            if streaming { &config.stt.mode } else { "batch" }
        );

        let raw = if streaming {
            let session = stt::spawn_live(
                api_key.clone(),
                config.stt.clone(),
                keyterms.clone(),
                http.clone(),
            );
            let bytes = pcm16_bytes(&wav.samples);
            let mut sent = 0usize;
            for chunk in bytes.chunks(3_200) {
                if session.audio_sender().send(chunk.to_vec()).is_err() {
                    eprintln!("[selftest] live task closed the audio channel");
                    break;
                }
                sent += chunk.len();
                // The shipping capture sends 100 ms chunks in real time; upload
                // at the same pace so the live endpoint sees what the app sends.
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            println!("[selftest] sent {} bytes of audio", sent);
            tokio::time::sleep(Duration::from_millis(300)).await;
            // Everything queued, as if the hotkey was just released.
            let stopped = Instant::now();
            match session.finish(Duration::from_secs(20)).await {
                Ok(text) => {
                    println!(
                        "[selftest] timing stop_to_transcript_ms={}",
                        stopped.elapsed().as_millis()
                    );
                    text
                }
                Err(error) => {
                    // Mirror the app: a failed live request falls back to the
                    // batch endpoint rather than losing the dictation.
                    eprintln!("[selftest] streaming failed: {error}; falling back to batch");
                    let wav_bytes = stt::wav_from_pcm16(&wav.samples, 16_000);
                    let fallback_started = Instant::now();
                    let text = match stt::transcribe_wav(
                        &http,
                        &api_key,
                        &keyterms,
                        wav_bytes,
                        &config.stt,
                    )
                    .await
                    {
                        Ok(text) => text,
                        Err(error) => {
                            eprintln!("[selftest] batch transcription failed: {error}");
                            return 1;
                        }
                    };
                    println!(
                        "[selftest] timing stop_to_transcript_ms={} fallback=batch",
                        fallback_started.elapsed().as_millis()
                    );
                    eprintln!("[selftest] note: live failed ({error}); batch succeeded");
                    text
                }
            }
        } else {
            let wav_bytes = stt::wav_from_pcm16(&wav.samples, 16_000);
            let stopped = Instant::now();
            match stt::transcribe_wav(&http, &api_key, &keyterms, wav_bytes, &config.stt).await {
                Ok(text) => {
                    println!(
                        "[selftest] timing stop_to_transcript_ms={}",
                        stopped.elapsed().as_millis()
                    );
                    text
                }
                Err(error) => {
                    eprintln!("[selftest] batch transcription failed: {error}");
                    return 1;
                }
            }
        };

        let raw = cleanup::sanitize_transcript(&raw);
        println!("\n--- RAW ---\n{raw}");

        let app_name =
            std::env::var("RAY_TEST_APP_NAME").unwrap_or_else(|_| "Notepad".to_string());
        let cleanup_started = Instant::now();
        let result = cleanup::cleanup(
            &http,
            &config.cleanup,
            config::EMBEDDED_PROMPT,
            &raw,
            &dictionary,
            &config.known_names,
            &app_name,
        )
        .await;
        let cleanup_ms = cleanup_started.elapsed().as_millis();
        println!("\n--- CLEAN ({}) ---\n{}", result
            .provider
            .clone()
            .unwrap_or_else(|| "raw fallback".into()), result.text);
        println!(
            "[selftest] timing cleanup_ms={} app_name={:?}",
            cleanup_ms, app_name
        );
        if std::env::var("RAY_TEST_REPEAT_CLEANUP").is_ok() {
            // A second call on the already-warm connection pool measures what a
            // normal (non-first) dictation pays.
            let warm_started = Instant::now();
            let warm = cleanup::cleanup(
                &http,
                &config.cleanup,
                config::EMBEDDED_PROMPT,
                &raw,
                &dictionary,
                &config.known_names,
                &app_name,
            )
            .await;
            println!(
                "[selftest] timing cleanup_warm_ms={}",
                warm_started.elapsed().as_millis()
            );
            let _ = warm;
        }
        if let Some(note) = result.note {
            println!("\n[selftest] note: {note}");
        }
        0
    })
}

struct WavFile {
    samples: Vec<i16>,
    sample_rate: u32,
}

fn read_wav(path: &str) -> Result<WavFile, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("Could not read {path}: {error}"))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!("{path} is not a RIFF/WAVE file"));
    }
    let mut position = 12usize;
    let mut format: Option<(u16, u16, u32, u16)> = None;
    let mut data: Option<Vec<u8>> = None;
    while position + 8 <= bytes.len() {
        let id = &bytes[position..position + 4];
        let size = u32::from_le_bytes(
            bytes[position + 4..position + 8]
                .try_into()
                .map_err(|_| "bad chunk size")?,
        ) as usize;
        let start = position + 8;
        let mut end = start.saturating_add(size);
        // Streaming encoders (including Deepgram's WAV output) leave a
        // placeholder size on the data chunk. Accept the rest of the file.
        if id == b"data" && end > bytes.len() {
            end = bytes.len();
        }
        if end > bytes.len() {
            break;
        }
        match id {
            b"fmt " if size >= 16 => {
                let code = u16::from_le_bytes([bytes[start], bytes[start + 1]]);
                let channels = u16::from_le_bytes([bytes[start + 2], bytes[start + 3]]);
                let rate = u32::from_le_bytes([
                    bytes[start + 4],
                    bytes[start + 5],
                    bytes[start + 6],
                    bytes[start + 7],
                ]);
                let bits = u16::from_le_bytes([bytes[start + 14], bytes[start + 15]]);
                format = Some((code, channels, rate, bits));
            }
            b"data" => data = Some(bytes[start..end].to_vec()),
            _ => {}
        }
        position = end + (size & 1);
    }

    let (code, channels, sample_rate, bits) =
        format.ok_or_else(|| "WAV has no fmt chunk".to_string())?;
    if bits != 16 || (code != 1 && code != 0xFFFE) {
        return Err(format!(
            "Expected 16-bit PCM WAV, got format {code} with {bits}-bit samples"
        ));
    }
    if sample_rate == 0 {
        return Err("WAV has a zero sample rate".into());
    }
    if channels == 0 {
        return Err("WAV has zero channels".into());
    }
    let data = data.ok_or_else(|| "WAV has no data chunk".to_string())?;
    let frames: Vec<i16> = data
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let samples = if channels == 1 {
        frames
    } else {
        frames
            .chunks(channels as usize)
            .map(|frame| {
                let sum: i32 = frame.iter().map(|sample| *sample as i32).sum();
                (sum / frame.len() as i32) as i16
            })
            .collect()
    };
    Ok(WavFile {
        samples,
        sample_rate,
    })
}

fn pcm16_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

/// `ray --selftest-mic`: verifies that the real capture path opens the
/// microphone and produces PCM without speaking.
pub fn run_mic_test() -> i32 {
    use std::sync::atomic::Ordering;

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("[mic] could not start the runtime: {error}");
            return 2;
        }
    };
    runtime.block_on(async {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let capture = match tokio::task::spawn_blocking(move || crate::audio::start(None, tx)).await
        {
            Ok(Ok(capture)) => capture,
            Ok(Err(error)) => {
                eprintln!("[mic] {error}");
                return 1;
            }
            Err(error) => {
                eprintln!("[mic] task failed: {error}");
                return 1;
            }
        };
        let level = capture.level_handle();
        let mut peak = 0f32;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            peak = peak.max(f32::from_bits(level.load(Ordering::Relaxed)));
        }
        let samples = tokio::task::spawn_blocking(move || {
            let mut capture = capture;
            capture.stop()
        })
        .await
        .unwrap_or_default();
        drop(rx);
        println!(
            "[mic] {} samples ({:.1}s at 16 kHz), peak level {:.2}",
            samples.len(),
            samples.len() as f32 / 16_000.0,
            peak
        );
        if samples.len() >= 16_000 {
            0
        } else {
            eprintln!("[mic] expected at least one second of audio");
            1
        }
    })
}
