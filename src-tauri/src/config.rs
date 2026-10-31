//! Pipeline configuration and the cleanup prompt.
//!
//! Both are embedded in the binary but can be overridden at runtime by files in
//! the app-data directory (`pipeline.json`, `cleanup.md`). This is the one place
//! where models, endpoints, and STT options live. The defaults are the result of
//! `research/final/`: AssemblyAI Sync live STT + a Gemma cleanup pass on the
//! AssemblyAI LLM Gateway, with a Groq fallback.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const EMBEDDED_PIPELINE: &str = include_str!("../config/pipeline.json");
pub const EMBEDDED_PROMPT: &str = include_str!("../prompts/cleanup.md");

pub fn default_known_names() -> Vec<String> {
    [
        "Arham",
        "Helion",
        "Ray",
        "Claude",
        "ChatGPT",
        "Grok",
        "Groq",
        "Gemini",
        "Anthropic",
        "OpenAI",
        "Vercel",
        "Tauri",
        "Supabase",
        "Linear",
        "Notion",
        "Kubernetes",
        "PostgreSQL",
        "Next.js",
        "shadcn",
        "Tailwind",
        "TypeScript",
        "GitHub",
        "Slack",
        "Deepgram",
        "AssemblyAI",
        "Typeless",
        "Rust",
        "pnpm",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub fn default_stt_prompt() -> String {
    "A work dictation from a software founder, PM or engineer: messages, emails, meeting \
     notes, technical instructions and casual replies. Vocabulary includes AI and developer \
     tools (Claude, ChatGPT, Grok, Groq, Anthropic, OpenAI, Vercel, Tauri, Supabase, Linear, \
     Notion, Kubernetes, PostgreSQL, Next.js, shadcn), the company Helion, teammates' names, \
     and the product Ray. Speech may contain filler words, false starts and self-corrections; \
     transcribe faithfully."
        .into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PipelineConfig {
    pub stt: SttConfig,
    pub cleanup: CleanupConfig,
    #[serde(default = "default_known_names")]
    pub known_names: Vec<String>,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        // One source of truth: the checked-in JSON. PipelineConfig itself does
        // not derive `serde(default)` (which would recurse through this).
        serde_json::from_str(EMBEDDED_PIPELINE).expect("embedded pipeline.json is valid")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct SttConfig {
    pub provider: String,
    pub streaming: bool,
    /// `sync_live` (recommended) or `websocket`.
    pub mode: String,
    /// WebSocket streaming model (used only in `websocket` mode).
    pub speech_model: String,
    /// Context passed to the recognizer.
    pub prompt: String,
    pub language_codes: Vec<String>,
    pub sample_rate: u32,
    pub encoding: String,
    pub format_turns: bool,
    pub max_turn_silence: u32,
    pub end_of_turn_confidence_threshold: f32,
    pub force_endpoint_timeout_ms: u64,
    pub terminate_timeout_ms: u64,
    pub connect_timeout_ms: u64,
    pub keyterms_limit: usize,
    pub sync_live: SyncLiveConfig,
    pub batch: BatchConfig,
}

impl Default for SttConfig {
    fn default() -> Self {
        Self {
            provider: "assemblyai".into(),
            streaming: true,
            mode: "sync_live".into(),
            speech_model: "universal-3-6-pro".into(),
            prompt: default_stt_prompt(),
            language_codes: vec!["en".into()],
            sample_rate: 16_000,
            encoding: "pcm_s16le".into(),
            format_turns: true,
            max_turn_silence: 700,
            end_of_turn_confidence_threshold: 0.4,
            force_endpoint_timeout_ms: 2_500,
            terminate_timeout_ms: 1_800,
            connect_timeout_ms: 8_000,
            keyterms_limit: 100,
            sync_live: SyncLiveConfig::default(),
            batch: BatchConfig::default(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct SyncLiveConfig {
    pub endpoint: String,
    pub model: String,
    pub max_audio_seconds: u64,
    pub request_timeout_ms: u64,
}

impl Default for SyncLiveConfig {
    fn default() -> Self {
        Self {
            endpoint: "https://sync.assemblyai.com/v1/transcribe/live".into(),
            model: "universal-3-5-pro".into(),
            max_audio_seconds: 120,
            request_timeout_ms: 300_000,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct BatchConfig {
    /// AssemblyAI Sync batch endpoint (fast path when live fails).
    pub endpoint: String,
    pub model: String,
    /// Keep the older asynchronous v2 upload/poll API as a second fallback.
    pub v2_fallback: bool,
    pub speech_models: Vec<String>,
    pub poll_interval_ms: u64,
    pub timeout_ms: u64,
}

impl Default for BatchConfig {
    fn default() -> Self {
        Self {
            endpoint: "https://sync.assemblyai.com/v1/transcribe".into(),
            model: "universal-3-5-pro".into(),
            v2_fallback: true,
            speech_models: vec!["universal-3-5-pro".into(), "universal-2".into()],
            poll_interval_ms: 700,
            timeout_ms: 45_000,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct CleanupConfig {
    pub enabled: bool,
    pub temperature: f32,
    pub max_tokens: u32,
    pub timeout_ms: u64,
    pub retries: u32,
    pub backoff_ms: Vec<u64>,
    pub providers: Vec<CleanupProvider>,
}

impl Default for CleanupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            temperature: 0.0,
            max_tokens: 1_200,
            timeout_ms: 15_000,
            retries: 2,
            backoff_ms: vec![300, 900],
            providers: vec![
                CleanupProvider {
                    id: "assemblyai".into(),
                    base_url: "https://llm-gateway.assemblyai.com/v1".into(),
                    model: "gemma-4-31b".into(),
                    api_key_secret: "assemblyai".into(),
                    extra_body: None,
                },
                CleanupProvider {
                    id: "groq".into(),
                    base_url: "https://api.groq.com/openai/v1".into(),
                    model: "openai/gpt-oss-120b".into(),
                    api_key_secret: "groq".into(),
                    extra_body: Some(serde_json::json!({ "reasoning_effort": "low" })),
                },
                CleanupProvider {
                    id: "vercel".into(),
                    base_url: "https://ai-gateway.vercel.sh/v1".into(),
                    model: "openai/gpt-4o-mini".into(),
                    api_key_secret: "vercel".into(),
                    extra_body: None,
                },
            ],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CleanupProvider {
    pub id: String,
    pub base_url: String,
    pub model: String,
    pub api_key_secret: String,
    #[serde(default)]
    pub extra_body: Option<serde_json::Value>,
}

/// Files a user (or the research agent) can drop into the app-data directory to
/// override the embedded pipeline without a rebuild.
#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub pipeline: PipelineConfig,
    pub prompt: String,
    pub pipeline_source: String,
    pub prompt_source: String,
}

impl RuntimeConfig {
    pub fn load(app_data: &Path) -> Self {
        let pipeline_override = app_data.join("pipeline.json");
        let prompt_override = app_data.join("cleanup.md");

        let (pipeline, pipeline_source) = match std::fs::read_to_string(&pipeline_override) {
            Ok(text) => match serde_json::from_str::<PipelineConfig>(&text) {
                Ok(config) => (config, format!("{}", pipeline_override.display())),
                Err(error) => {
                    eprintln!("[ray] ignoring invalid pipeline.json override: {error}");
                    (PipelineConfig::default(), "embedded".into())
                }
            },
            Err(_) => (PipelineConfig::default(), "embedded".into()),
        };

        let (prompt, prompt_source) = match std::fs::read_to_string(&prompt_override) {
            Ok(text) if !text.trim().is_empty() => (text, format!("{}", prompt_override.display())),
            _ => (EMBEDDED_PROMPT.to_string(), "embedded".into()),
        };

        Self {
            pipeline,
            prompt,
            pipeline_source,
            prompt_source,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_pipeline_parses_and_matches_the_recommendation() {
        let config = PipelineConfig::default();
        assert_eq!(config.stt.mode, "sync_live");
        assert_eq!(config.stt.sync_live.model, "universal-3-5-pro");
        assert_eq!(config.cleanup.providers[0].model, "gemma-4-31b");
        assert_eq!(config.cleanup.providers[1].model, "openai/gpt-oss-120b");
        assert!(config.known_names.iter().any(|name| name == "Helion"));
        assert!(!EMBEDDED_PROMPT.trim().is_empty());
    }
}
