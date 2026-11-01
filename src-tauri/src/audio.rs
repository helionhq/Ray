//! Microphone capture with streaming resampling to 16 kHz mono PCM16.
//!
//! cpal's stream is created and owned by a dedicated thread (some backends
//! make it neither Send nor Sync). The callback downmixes to mono, low-pass
//! filters while downsampling, emits 100 ms PCM chunks for AssemblyAI's
//! streaming endpoint, and keeps a full buffer for the batch fallback.
//! The level is published as an atomic so the UI can read it cheaply.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use tokio::sync::mpsc::UnboundedSender;

pub const TARGET_RATE: u32 = 16_000;
const CHUNK_SAMPLES: usize = 1_600; // 100 ms at 16 kHz
const MAX_RECORDING_SAMPLES: usize = TARGET_RATE as usize * 60 * 5;

#[derive(Clone, Debug, serde::Serialize)]
pub struct InputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

pub fn list_input_devices() -> Result<Vec<InputDevice>, String> {
    let host = cpal::default_host();
    let default_id = host
        .default_input_device()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());
    let devices = host
        .input_devices()
        .map_err(|error| format!("Could not list microphones: {error}"))?;
    let mut out = Vec::new();
    for device in devices {
        if !device.supports_input() {
            continue;
        }
        let id = device.id().map(|id| id.to_string()).unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        out.push(InputDevice {
            is_default: default_id.as_deref() == Some(id.as_str()),
            name: device.to_string(),
            id,
        });
    }
    out.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.name.cmp(&b.name)));
    Ok(out)
}

pub struct Capture {
    stop: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
    pcm: Arc<Mutex<Vec<i16>>>,
    error: Arc<Mutex<Option<String>>>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Capture {
    pub fn error(&self) -> Option<String> {
        self.error.lock().unwrap().clone()
    }

    pub fn level_handle(&self) -> Arc<AtomicU32> {
        self.level.clone()
    }

    /// Stops the stream and returns every captured sample.
    pub fn stop(&mut self) -> Vec<i16> {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let samples = self.pcm.lock().unwrap().clone();
        samples
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn start(
    device_id: Option<String>,
    audio_tx: UnboundedSender<Vec<u8>>,
) -> Result<Capture, String> {
    // Deterministic end-to-end tests: feed a raw 16 kHz mono PCM file through
    // the real capture path instead of the microphone. Debug builds only.
    #[cfg(debug_assertions)]
    if let Ok(path) = std::env::var("RAY_TEST_PCM") {
        if !path.trim().is_empty() {
            return start_fake_capture(path.trim(), audio_tx);
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let level = Arc::new(AtomicU32::new(0f32.to_bits()));
    let pcm = Arc::new(Mutex::new(Vec::with_capacity(TARGET_RATE as usize * 20)));
    let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();

    let thread_stop = stop.clone();
    let thread_level = level.clone();
    let thread_pcm = pcm.clone();
    let thread_error = error.clone();
    let thread = thread::Builder::new()
        .name("ray-audio".into())
        .spawn(move || {
            if let Err(message) = run_capture(
                device_id,
                audio_tx,
                thread_stop.clone(),
                thread_level,
                thread_pcm,
                thread_error.clone(),
                ready_tx,
            ) {
                *thread_error.lock().unwrap() = Some(message);
            }
            // `run_capture` blocks until the stop flag is set and the stream
            // is dropped.
        })
        .map_err(|error| format!("Could not start the audio thread: {error}"))?;

    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(_sample_rate)) => Ok(Capture {
            stop,
            level,
            pcm,
            error,
            thread: Some(thread),
        }),
        Ok(Err(message)) => {
            let _ = thread.join();
            Err(message)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            // The worker exited without reporting ready; join it and surface
            // whatever error it recorded.
            let _ = thread.join();
            Err(error
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| "The audio capture stopped unexpectedly".into()))
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            let _ = thread.join();
            Err("The microphone did not start in time".into())
        }
    }
}

struct Processor {
    resampler: Resampler,
    pending: Vec<i16>,
    pcm: Arc<Mutex<Vec<i16>>>,
    level: Arc<AtomicU32>,
    audio_tx: UnboundedSender<Vec<u8>>,
    smoothed_level: f32,
}

impl Processor {
    fn new(
        in_rate: u32,
        pcm: Arc<Mutex<Vec<i16>>>,
        level: Arc<AtomicU32>,
        audio_tx: UnboundedSender<Vec<u8>>,
    ) -> Self {
        Self {
            resampler: Resampler::new(in_rate, TARGET_RATE),
            pending: Vec::with_capacity(CHUNK_SAMPLES * 2),
            pcm,
            level,
            audio_tx,
            smoothed_level: 0.0,
        }
    }

    fn push_mono(&mut self, mono: &[f32]) {
        if mono.is_empty() {
            return;
        }
        let mut sum = 0.0f32;
        for sample in mono {
            sum += sample * sample;
        }
        let rms = (sum / mono.len() as f32).sqrt();
        let db = 20.0 * (rms.max(1e-7)).log10();
        // -60 dBFS is silence, -10 dBFS is loud speech.
        let target = ((db + 60.0) / 50.0).clamp(0.0, 1.0);
        let rate = if target > self.smoothed_level {
            0.45
        } else {
            0.12
        };
        self.smoothed_level += (target - self.smoothed_level) * rate;
        self.level
            .store(self.smoothed_level.to_bits(), Ordering::Relaxed);

        let pcm = self.resampler.process(mono);
        if pcm.is_empty() {
            return;
        }
        {
            let mut buffer = self.pcm.lock().unwrap();
            if buffer.len() < MAX_RECORDING_SAMPLES {
                buffer.extend_from_slice(&pcm);
            }
        }
        self.pending.extend_from_slice(&pcm);
        while self.pending.len() >= CHUNK_SAMPLES {
            let rest = self.pending.split_off(CHUNK_SAMPLES);
            let chunk = std::mem::replace(&mut self.pending, rest);
            let bytes = pcm16_bytes(&chunk);
            if self.audio_tx.send(bytes).is_err() {
                // The streaming task is gone (no key, or it failed). Keep
                // recording for the batch fallback; just stop queueing.
            }
        }
    }

    fn flush(&mut self) {
        if !self.pending.is_empty() {
            let bytes = pcm16_bytes(&self.pending);
            let _ = self.audio_tx.send(bytes);
            self.pending.clear();
        }
    }
}

fn pcm16_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

fn run_capture(
    device_id: Option<String>,
    audio_tx: UnboundedSender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
    pcm: Arc<Mutex<Vec<i16>>>,
    error: Arc<Mutex<Option<String>>>,
    ready_tx: mpsc::Sender<Result<u32, String>>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = match device_id.as_deref() {
        Some(id) if !id.is_empty() => host
            .device_by_id(
                &id.parse()
                    .map_err(|_| "Invalid microphone id".to_string())?,
            )
            .or_else(|| host.default_input_device())
            .ok_or_else(|| "No microphone found".to_string())?,
        _ => host
            .default_input_device()
            .ok_or_else(|| "No microphone found".to_string())?,
    };

    if !device.supports_input() {
        return Err("The selected device does not accept audio input".into());
    }
    let config = device
        .default_input_config()
        .map_err(|error| format!("Could not read the microphone format: {error}"))?;
    let in_rate = config.sample_rate();
    let sample_format = config.sample_format();

    let processor = Arc::new(Mutex::new(Processor::new(in_rate, pcm, level, audio_tx)));

    let err_fn = {
        let error = error.clone();
        move |err: cpal::Error| {
            let mut slot = error.lock().unwrap();
            if slot.is_none() {
                *slot = Some(format!("Microphone error: {err}"));
            }
        }
    };

    let stream = match sample_format {
        SampleFormat::F32 => build::<f32>(&device, &config, processor.clone(), err_fn),
        SampleFormat::I16 => build::<i16>(&device, &config, processor.clone(), err_fn),
        SampleFormat::U16 => build::<u16>(&device, &config, processor.clone(), err_fn),
        SampleFormat::I32 => build::<i32>(&device, &config, processor.clone(), err_fn),
        SampleFormat::I8 => build::<i8>(&device, &config, processor.clone(), err_fn),
        other => Err(format!("Unsupported microphone format: {other}")),
    }?;

    stream
        .play()
        .map_err(|error| format!("Could not start the microphone: {error}"))?;

    // The stream is live; hand the capture back to `start`.
    let _ = ready_tx.send(Ok(in_rate));

    while !stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(12));
    }
    drop(stream);
    if let Ok(mut processor) = processor.lock() {
        processor.flush();
    }
    Ok(())
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    processor: Arc<Mutex<Processor>>,
    err_fn: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Sample,
    f32: FromSample<T>,
{
    let channels = config.channels() as usize;
    device
        .build_input_stream(
            (*config).into(),
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let Ok(mut processor) = processor.try_lock() else {
                    return;
                };
                let mut mono = Vec::with_capacity(data.len() / channels.max(1));
                for frame in data.chunks(channels.max(1)) {
                    let mut sum = 0.0f32;
                    for sample in frame {
                        sum += f32::from_sample(*sample);
                    }
                    mono.push(sum / frame.len() as f32);
                }
                processor.push_mono(&mono);
            },
            err_fn,
            None,
        )
        .map_err(|error| format!("Could not open the microphone: {error}"))
}

/// A 2nd-order Butterworth low-pass used before decimation.
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    fn low_pass(sample_rate: f32, cutoff: f32) -> Self {
        let w0 = 2.0 * std::f32::consts::PI * cutoff / sample_rate;
        let cos = w0.cos();
        let alpha = w0.sin() / (2.0 * 0.707_106_77);
        let a0 = 1.0 + alpha;
        Self {
            b0: (1.0 - cos) * 0.5 / a0,
            b1: (1.0 - cos) / a0,
            b2: (1.0 - cos) * 0.5 / a0,
            a1: (-2.0 * cos) / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// Streaming linear-interpolating resampler. Downsampling is preceded by a
/// low-pass at 7 kHz so speech does not alias into the 16 kHz stream.
struct Resampler {
    ratio: f64,
    filter: Option<Biquad>,
    next_out: f64,
    index: u64,
    prev: f32,
}

impl Resampler {
    fn new(in_rate: u32, out_rate: u32) -> Self {
        let ratio = in_rate as f64 / out_rate as f64;
        let filter = (in_rate > out_rate).then(|| Biquad::low_pass(in_rate as f32, 7_000.0));
        Self {
            ratio,
            filter,
            next_out: 0.0,
            index: 0,
            prev: 0.0,
        }
    }

    fn process(&mut self, input: &[f32]) -> Vec<i16> {
        let mut out = Vec::with_capacity((input.len() as f64 / self.ratio) as usize + 2);
        for &raw in input {
            let sample = match &mut self.filter {
                Some(filter) => filter.process(raw),
                None => raw,
            };
            if self.index == 0 {
                self.prev = sample;
            }
            while self.next_out <= self.index as f64 {
                let frac = if self.index == 0 {
                    1.0
                } else {
                    (self.next_out - (self.index as f64 - 1.0)).clamp(0.0, 1.0) as f32
                };
                let value = self.prev + (sample - self.prev) * frac;
                out.push((value.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
                self.next_out += self.ratio;
            }
            self.prev = sample;
            self.index += 1;
        }
        out
    }
}

/// Test-only capture: streams a raw 16 kHz mono PCM16 file at just above real
/// time, so hotkey → STT → cleanup → paste can be exercised without a mic.
#[cfg(debug_assertions)]
fn start_fake_capture(path: &str, audio_tx: UnboundedSender<Vec<u8>>) -> Result<Capture, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("Could not read {path}: {error}"))?;
    let samples: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    if samples.is_empty() {
        return Err("The test PCM file is empty".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let level = Arc::new(AtomicU32::new(0f32.to_bits()));
    let pcm: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::with_capacity(samples.len())));
    let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let thread_stop = stop.clone();
    let thread_level = level.clone();
    let thread_pcm = pcm.clone();
    let thread = thread::Builder::new()
        .name("ray-test-audio".into())
        .spawn(move || {
            let mut position = 0usize;
            let mut smoothed = 0.0f32;
            while !thread_stop.load(Ordering::SeqCst) && position < samples.len() {
                let end = (position + CHUNK_SAMPLES).min(samples.len());
                let chunk = &samples[position..end];
                let mut sum = 0.0f32;
                for sample in chunk {
                    let value = *sample as f32 / i16::MAX as f32;
                    sum += value * value;
                }
                let rms = (sum / chunk.len() as f32).sqrt();
                let db = 20.0 * rms.max(1e-7).log10();
                smoothed += (((db + 60.0) / 50.0).clamp(0.0, 1.0) - smoothed) * 0.4;
                thread_level.store(smoothed.to_bits(), Ordering::Relaxed);
                thread_pcm.lock().unwrap().extend_from_slice(chunk);
                let mut bytes = Vec::with_capacity(chunk.len() * 2);
                for sample in chunk {
                    bytes.extend_from_slice(&sample.to_le_bytes());
                }
                let _ = audio_tx.send(bytes);
                position = end;
                thread::sleep(Duration::from_millis(90));
            }
        })
        .map_err(|error| format!("Could not start the test audio thread: {error}"))?;
    Ok(Capture {
        stop,
        level,
        pcm,
        error,
        thread: Some(thread),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsamples_48k_to_16k_without_changing_level() {
        let mut resampler = Resampler::new(48_000, 16_000);
        let output = resampler.process(&vec![0.5f32; 4_800]);
        assert!(
            (output.len() as i32 - 1_600).abs() <= 2,
            "got {} samples",
            output.len()
        );
        for sample in output.iter().skip(200) {
            let value = *sample as f32 / i16::MAX as f32;
            assert!((value - 0.5).abs() < 0.02, "value was {value}");
        }
    }

    #[test]
    fn upsamples_8k_to_16k() {
        let mut resampler = Resampler::new(8_000, 16_000);
        let output = resampler.process(&vec![0.25f32; 800]);
        assert!(
            (output.len() as i32 - 1_600).abs() <= 2,
            "got {} samples",
            output.len()
        );
    }
}
