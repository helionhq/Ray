//! Pipeline configuration and the cleanup prompts.
//!
//! Both are embedded in the binary but can be overridden at runtime by files in
//! the app-data directory (`pipeline.json`, `cleanup.md`). This is the one
//! place where models, endpoints, and STT options live. The defaults are
//! AssemblyAI Sync live STT + a Gemma cleanup pass on the AssemblyAI LLM
//! Gateway.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const EMBEDDED_PIPELINE: &str = include_str!("../config/pipeline.json");
pub const EMBEDDED_PROMPT: &str = include_str!("../prompts/cleanup.md");
pub fn default_known_names() -> Vec<String> {
    [
        "ChatGPT",
        "Claude",
        "Claude Code",
        "OpenAI",
        "Anthropic",
        "Gemini",
        "Gemma",
        "Qwen",
        "Kimi",
        "DeepSeek",
        "Llama",
        "Mistral",
        "Codex",
        "Ollama",
        "Hugging Face",
        "OpenRouter",
        "GitHub",
        "Vercel",
        "Supabase",
        "Cloudflare",
        "PostgreSQL",
        "TypeScript",
        "JavaScript",
        "Next.js",
        "Tailwind",
        "Notion",
        "Slack",
        "Linear",
        "Figma",
        "WhatsApp",
        "LinkedIn",
        "YouTube",
        "iPhone",
        "macOS",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub fn default_stt_prompt() -> String {
    "Dictation of messages, emails, notes, documents and instructions for AI assistants, \
     often with names, products and technical terms. Speech may contain filler words, \
     false starts and self-corrections; transcribe faithfully."
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
    /// Hard limit for one provider request (including reading the body), for
    /// an empty transcript. `timeout_ms_per_word` is added per spoken word.
    #[serde(default = "default_cleanup_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_timeout_ms_per_word")]
    pub timeout_ms_per_word: u64,
    /// Fire the fallback in parallel when the primary has not answered by then
    /// (plus `hedge_after_ms_per_word` per spoken word). The gateway stalls on
    /// roughly 1% of requests regardless of length, so the hedge sits just
    /// above the normal latency for that length and only touches the tail.
    #[serde(default = "default_hedge_after_ms")]
    pub hedge_after_ms: u64,
    #[serde(default = "default_hedge_after_ms_per_word")]
    pub hedge_after_ms_per_word: u64,
    pub retries: u32,
    pub backoff_ms: Vec<u64>,
    pub providers: Vec<CleanupProvider>,
}

impl CleanupConfig {
    /// The config with timeout and hedge scaled to the transcript length: a
    /// 600-word dictation legitimately takes several times longer to rewrite
    /// than a one-liner, and a fixed limit either cuts long ones off or waits
    /// far too long on a stalled short one.
    pub fn scaled_for(&self, transcript: &str) -> Self {
        let words = transcript.split_whitespace().count() as u64;
        let mut config = self.clone();
        config.timeout_ms = self
            .timeout_ms
            .saturating_add(words.saturating_mul(self.timeout_ms_per_word));
        config.hedge_after_ms = self
            .hedge_after_ms
            .saturating_add(words.saturating_mul(self.hedge_after_ms_per_word));
        config
    }
}

pub fn default_cleanup_timeout_ms() -> u64 {
    6_000
}

pub fn default_timeout_ms_per_word() -> u64 {
    0
}

pub fn default_hedge_after_ms() -> u64 {
    2_500
}

pub fn default_hedge_after_ms_per_word() -> u64 {
    0
}

impl Default for CleanupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            temperature: 0.0,
            max_tokens: 3_000,
            timeout_ms: default_cleanup_timeout_ms(),
            timeout_ms_per_word: default_timeout_ms_per_word(),
            hedge_after_ms: default_hedge_after_ms(),
            hedge_after_ms_per_word: default_hedge_after_ms_per_word(),
            retries: 2,
            backoff_ms: vec![300, 900],
            providers: vec![CleanupProvider {
                id: "assemblyai".into(),
                base_url: "https://llm-gateway.assemblyai.com/v1".into(),
                model: "gemma-4-31b".into(),
                api_key_secret: "assemblyai".into(),
                extra_body: None,
            }],
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
}

/// Whether `provider` belongs to a backend Ray has retired. Startup deletes
/// retired credentials, so a legacy override that still lists one would have
/// every cleanup request fail and the user would get the raw transcript.
fn is_retired_provider(provider: &CleanupProvider) -> bool {
    let is_retired_name = |value: &str| {
        crate::secrets::RETIRED
            .iter()
            .any(|retired| value.eq_ignore_ascii_case(retired))
    };
    // The endpoint is the third signal: older overrides may use a custom id or
    // secret name but still point at the retired provider's API host.
    let uses_retired_host = url::Url::parse(&provider.base_url).is_ok_and(|url| {
        url.host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("api.groq.com"))
    });
    is_retired_name(&provider.id) || is_retired_name(&provider.api_key_secret) || uses_retired_host
}

/// Remove retired providers from a parsed override, keeping the order of the
/// remaining supported providers. When none remain, fall back to the embedded
/// default so cleanup still runs.
fn remove_retired_providers(pipeline: &mut PipelineConfig) {
    let before = pipeline.cleanup.providers.len();
    pipeline
        .cleanup
        .providers
        .retain(|provider| !is_retired_provider(provider));
    let removed = before - pipeline.cleanup.providers.len();
    if removed == 0 {
        return;
    }
    eprintln!("[ray] removed {removed} retired cleanup provider(s) from pipeline.json override");
    if pipeline.cleanup.providers.is_empty() {
        pipeline.cleanup.providers = PipelineConfig::default().cleanup.providers;
        eprintln!("[ray] no supported cleanup providers remain; using the embedded default");
    }
}

impl RuntimeConfig {
    pub fn load(app_data: &Path) -> Self {
        let pipeline_override = app_data.join("pipeline.json");

        // Overrides written while Ray had two cleanup modes may still contain
        // `cleanup.modes`; serde ignores the unknown key, so they still load.
        let pipeline = match std::fs::read_to_string(&pipeline_override) {
            Ok(text) => match serde_json::from_str::<PipelineConfig>(&text) {
                Ok(mut config) => {
                    // Any override may still list a provider whose credentials
                    // startup deletes; drop it so cleanup keeps working and
                    // falls back to the embedded default only when nothing
                    // supported is left.
                    remove_retired_providers(&mut config);
                    config
                }
                Err(error) => {
                    eprintln!("[ray] ignoring invalid pipeline.json override: {error}");
                    PipelineConfig::default()
                }
            },
            Err(_) => PipelineConfig::default(),
        };

        let read_prompt =
            |name: &str, embedded: &str| match std::fs::read_to_string(app_data.join(name)) {
                Ok(text) if !text.trim().is_empty() => text,
                _ => embedded.to_string(),
            };

        Self {
            pipeline,
            prompt: read_prompt("cleanup.md", EMBEDDED_PROMPT),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A per-test directory so parallel tests never share override files.
    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ray-config-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn embedded_pipeline_parses_and_matches_the_recommendation() {
        let config = PipelineConfig::default();
        assert_eq!(config.stt.mode, "sync_live");
        assert_eq!(config.stt.sync_live.model, "universal-3-5-pro");
        assert_eq!(config.cleanup.providers[0].model, "gemma-4-31b");
        assert!(config.cleanup.providers.iter().all(|p| p.id != "groq"));
        assert_eq!(config.cleanup.max_tokens, 3_000);
        assert!(!EMBEDDED_PROMPT.trim().is_empty());
        // The built-in lists are general: nothing personal to one user.
        for personal in ["Arham", "Helion", "Ray"] {
            assert!(!config.known_names.iter().any(|name| name == personal));
            assert!(!config.stt.prompt.contains(personal));
        }
    }

    #[test]
    fn timeout_and_hedge_scale_with_transcript_length() {
        let cleanup: CleanupConfig = serde_json::from_str(
            r#"{"timeout_ms":6000,"timeout_ms_per_word":20,
                "hedge_after_ms":3000,"hedge_after_ms_per_word":10}"#,
        )
        .unwrap();
        let short = cleanup.scaled_for("send it");
        assert_eq!(short.timeout_ms, 6_040);
        assert_eq!(short.hedge_after_ms, 3_020);
        let long = cleanup.scaled_for(&"word ".repeat(500));
        assert_eq!(long.timeout_ms, 16_000);
        assert_eq!(long.hedge_after_ms, 8_000);
        // The unscaled config is untouched.
        assert_eq!(cleanup.timeout_ms, 6_000);
    }

    #[test]
    fn older_cleanup_overrides_get_the_timing_defaults() {
        // A user's app-data pipeline.json written before hedging existed must
        // still load, with sensible timeout defaults rather than zero.
        let cleanup: CleanupConfig = serde_json::from_str(
            r#"{"enabled":true,"temperature":0,"max_tokens":1500,"retries":2,
                "backoff_ms":[300,900],"providers":[]}"#,
        )
        .unwrap();
        assert_eq!(cleanup.timeout_ms, 6_000);
        assert_eq!(cleanup.hedge_after_ms, 2_500);
        assert_eq!(cleanup.scaled_for("a b c").timeout_ms, 6_000);
    }

    #[test]
    fn overrides_from_the_two_mode_era_still_load() {
        let dir = temp_dir("legacy-modes");
        std::fs::write(
            dir.join("pipeline.json"),
            r#"{"stt":{},"cleanup":{"enabled":true,"temperature":0,
                "max_tokens":1500,"retries":2,"backoff_ms":[300,900],
                "providers":[{"id":"assemblyai",
                    "base_url":"https://llm-gateway.assemblyai.com/v1",
                    "model":"claude-sonnet-4-5","api_key_secret":"assemblyai"}],
                "modes":{"structured":{"max_tokens":4200}}}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("structured.md"), "IGNORED").unwrap();
        let runtime = RuntimeConfig::load(&dir);
        assert_eq!(
            runtime.pipeline.cleanup.providers[0].model,
            "claude-sonnet-4-5"
        );
        assert_eq!(runtime.pipeline.cleanup.max_tokens, 1_500);
        assert_eq!(runtime.prompt, EMBEDDED_PROMPT);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn runtime_prompt_override_is_used() {
        let dir = temp_dir("prompt-override");
        std::fs::write(dir.join("cleanup.md"), "# Cleanup\n\nCUSTOM PROMPT").unwrap();
        let runtime = RuntimeConfig::load(&dir);
        assert_eq!(runtime.prompt, "# Cleanup\n\nCUSTOM PROMPT");
        std::fs::remove_dir_all(&dir).ok();
        let runtime = RuntimeConfig::load(&dir);
        assert_eq!(runtime.prompt, EMBEDDED_PROMPT);
    }

    #[test]
    fn legacy_override_with_only_groq_falls_back_to_embedded_defaults() {
        let dir = temp_dir("legacy-groq-only");
        // Each provider is identified as retired by a different signal: the
        // id, the secret name, or the API host.
        std::fs::write(
            dir.join("pipeline.json"),
            r#"{"stt":{},"cleanup":{"enabled":true,"temperature":0,
                "max_tokens":1500,"retries":2,"backoff_ms":[300,900],
                "providers":[
                    {"id":"Groq","base_url":"https://example.com/v1",
                        "model":"llama-3.3-70b","api_key_secret":"custom"},
                    {"id":"custom","base_url":"https://example.com/v1",
                        "model":"llama-3.3-70b","api_key_secret":"GROQ"},
                    {"id":"custom","base_url":"https://api.groq.com/openai/v1",
                        "model":"llama-3.3-70b","api_key_secret":"custom"}
                ]}}"#,
        )
        .unwrap();

        let runtime = RuntimeConfig::load(&dir);
        assert_eq!(
            serde_json::to_value(&runtime.pipeline.cleanup.providers).unwrap(),
            serde_json::to_value(&PipelineConfig::default().cleanup.providers).unwrap()
        );
        assert_eq!(runtime.pipeline.cleanup.providers[0].id, "assemblyai");
        assert_eq!(runtime.pipeline.cleanup.providers[0].model, "gemma-4-31b");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_override_drops_groq_and_keeps_supported_providers_in_order() {
        let dir = temp_dir("legacy-groq-primary");
        std::fs::write(
            dir.join("pipeline.json"),
            r#"{"stt":{},"cleanup":{"enabled":true,"temperature":0,
                "max_tokens":1500,"retries":2,"backoff_ms":[300,900],
                "providers":[
                    {"id":"groq","base_url":"https://api.groq.com/openai/v1",
                        "model":"llama-3.3-70b","api_key_secret":"groq"},
                    {"id":"assemblyai",
                        "base_url":"https://llm-gateway.assemblyai.com/v1",
                        "model":"gemma-4-31b","api_key_secret":"assemblyai"},
                    {"id":"vercel","base_url":"https://ai-gateway.vercel.sh/v1",
                        "model":"openai/gpt-5","api_key_secret":"vercel"}
                ]}}"#,
        )
        .unwrap();

        let runtime = RuntimeConfig::load(&dir);
        let providers = &runtime.pipeline.cleanup.providers;
        assert_eq!(
            providers.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["assemblyai", "vercel"]
        );
        assert_eq!(providers[0].model, "gemma-4-31b");
        assert_eq!(providers[0].api_key_secret, "assemblyai");
        assert_eq!(providers[1].base_url, "https://ai-gateway.vercel.sh/v1");
        assert_eq!(providers[1].model, "openai/gpt-5");
        assert_eq!(providers[1].api_key_secret, "vercel");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_override_without_retired_providers_is_unchanged() {
        let dir = temp_dir("legacy-supported-only");
        std::fs::write(
            dir.join("pipeline.json"),
            r#"{"stt":{},"cleanup":{"enabled":true,"temperature":0,
                "max_tokens":1500,"retries":2,"backoff_ms":[300,900],
                "providers":[
                    {"id":"assemblyai",
                        "base_url":"https://llm-gateway.assemblyai.com/v1",
                        "model":"claude-sonnet-4-5","api_key_secret":"assemblyai",
                        "extra_body":{"reasoning":{"effort":"low"}}}
                ]}}"#,
        )
        .unwrap();

        let runtime = RuntimeConfig::load(&dir);
        // Every field, including the custom model and extra body, survives.
        assert_eq!(
            serde_json::to_value(&runtime.pipeline.cleanup.providers).unwrap(),
            serde_json::json!([{
                "id": "assemblyai",
                "base_url": "https://llm-gateway.assemblyai.com/v1",
                "model": "claude-sonnet-4-5",
                "api_key_secret": "assemblyai",
                "extra_body": {"reasoning": {"effort": "low"}}
            }])
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_modes_key_does_not_exempt_retired_provider_filtering() {
        let dir = temp_dir("explicit-modes");
        std::fs::write(
            dir.join("pipeline.json"),
            r#"{"stt":{},"cleanup":{"enabled":true,"temperature":0,
                "max_tokens":1500,"retries":2,"backoff_ms":[300,900],
                "providers":[{"id":"assemblyai",
                    "base_url":"https://llm-gateway.assemblyai.com/v1",
                    "model":"claude-sonnet-4-5","api_key_secret":"assemblyai"}],
                "modes":{"structured":{"max_tokens":4200}}}}"#,
        )
        .unwrap();

        let runtime = RuntimeConfig::load(&dir);
        assert_eq!(runtime.pipeline.cleanup.providers.len(), 1);
        assert_eq!(
            runtime.pipeline.cleanup.providers[0].model,
            "claude-sonnet-4-5"
        );
        assert_eq!(runtime.pipeline.cleanup.max_tokens, 1_500);

        // A leftover modes key does not exempt an override from retired-provider
        // filtering: the supported provider survives and is retried first.
        std::fs::write(
            dir.join("pipeline.json"),
            r#"{"stt":{},"cleanup":{"enabled":true,"temperature":0,
                "max_tokens":1500,"retries":2,"backoff_ms":[300,900],
                "providers":[
                    {"id":"groq","base_url":"https://api.groq.com/openai/v1",
                        "model":"llama-3.3-70b","api_key_secret":"groq"},
                    {"id":"assemblyai",
                        "base_url":"https://llm-gateway.assemblyai.com/v1",
                        "model":"claude-sonnet-4-5","api_key_secret":"assemblyai"}
                ],
                "modes":{"structured":{"max_tokens":4200}}}}"#,
        )
        .unwrap();

        let runtime = RuntimeConfig::load(&dir);
        assert_eq!(
            runtime
                .pipeline
                .cleanup
                .providers
                .iter()
                .map(|provider| provider.id.as_str())
                .collect::<Vec<_>>(),
            ["assemblyai"]
        );

        // When an override leaves no supported provider, filtering falls back
        // to the embedded default so cleanup still has somewhere to run.
        std::fs::write(
            dir.join("pipeline.json"),
            r#"{"stt":{},"cleanup":{"enabled":true,"temperature":0,
                "max_tokens":1500,"retries":2,"backoff_ms":[300,900],
                "providers":[{"id":"groq",
                    "base_url":"https://api.groq.com/openai/v1",
                    "model":"llama-3.3-70b","api_key_secret":"groq"}],
                "modes":{"structured":{}}}}"#,
        )
        .unwrap();

        let runtime = RuntimeConfig::load(&dir);
        assert_eq!(
            serde_json::to_value(&runtime.pipeline.cleanup.providers).unwrap(),
            serde_json::to_value(&PipelineConfig::default().cleanup.providers).unwrap()
        );
        assert_eq!(runtime.pipeline.cleanup.providers[0].id, "assemblyai");

        // The embedded default never contains a retired provider.
        let defaults = PipelineConfig::default();
        assert_eq!(defaults.cleanup.providers[0].id, "assemblyai");
        assert!(defaults
            .cleanup
            .providers
            .iter()
            .all(|provider| !is_retired_provider(provider)));
        std::fs::remove_dir_all(&dir).ok();
    }
}
