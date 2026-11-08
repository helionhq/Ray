//! Pipeline configuration and the cleanup prompt.
//!
//! Both are embedded in the binary but can be overridden at runtime by files in
//! the app-data directory (`pipeline.json`, `structured.md`). This is the one
//! place where models, endpoints, and STT options live. Every network endpoint
//! derives from `api.base_url`, the Ray API origin; the device token is added
//! by the request code.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const EMBEDDED_PIPELINE: &str = include_str!("../config/pipeline.json");
pub const EMBEDDED_PROMPT: &str = include_str!("../prompts/structured.md");

/// The default Ray API origin. Kept here as well as in the checked-in JSON so
/// an old override without an `api` object still resolves somewhere sensible.
pub const DEFAULT_API_BASE: &str = "https://ray.helionhq.com";

pub fn default_known_names() -> Vec<String> {
    [
        "Arham",
        "Helion",
        "Ray",
        "Claude",
        "ChatGPT",
        "GPT-5",
        "Gemma",
        "gpt-oss",
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
     tools (Claude, ChatGPT, Gemma, gpt-oss, Grok, Groq, Anthropic, OpenAI, Vercel, \
     Tauri, Supabase, Linear, Notion, Kubernetes, PostgreSQL, Next.js, shadcn), the company \
     Helion, teammates' names, \
     and the product Ray. Speech may contain filler words, false starts and self-corrections; \
     transcribe faithfully."
        .into()
}

/// The Ray API origin. `RAY_API_BASE` wins over the checked-in or overridden
/// value; it is not a secret, so dev and release builds both honor it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct ApiConfig {
    pub base_url: String,
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_API_BASE.into(),
        }
    }
}

/// Resolve the origin from config + the environment. Split out so the rule is
/// testable without mutating process-wide environment variables.
pub fn resolve_api_base(configured: &str, env: Option<&str>) -> String {
    let env = env.map(str::trim).filter(|value| !value.is_empty());
    let value = env
        .or_else(|| {
            let configured = configured.trim();
            (!configured.is_empty()).then_some(configured)
        })
        .unwrap_or(DEFAULT_API_BASE);
    value.trim_end_matches('/').to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PipelineConfig {
    #[serde(default)]
    pub api: ApiConfig,
    #[serde(default)]
    pub stt: SttConfig,
    #[serde(default)]
    pub cleanup: CleanupConfig,
    #[serde(default = "default_known_names")]
    pub known_names: Vec<String>,
}

impl PipelineConfig {
    /// The effective API origin, with `RAY_API_BASE` taking precedence.
    pub fn api_base(&self) -> String {
        resolve_api_base(
            &self.api.base_url,
            std::env::var("RAY_API_BASE").ok().as_deref(),
        )
    }
}

impl Default for PipelineConfig {
    fn default() -> Self {
        // One source of truth: the checked-in JSON. Each field in the struct
        // has its own serde default, so an old override can omit `api` (added
        // after the first release) without losing the rest of its settings.
        serde_json::from_str(EMBEDDED_PIPELINE).expect("embedded pipeline.json is valid")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct SttConfig {
    /// Context passed to the recognizer.
    pub prompt: String,
    pub language_codes: Vec<String>,
    pub sample_rate: u32,
    pub force_endpoint_timeout_ms: u64,
    pub keyterms_limit: usize,
    pub sync_live: SyncLiveConfig,
    pub batch: BatchConfig,
}

impl Default for SttConfig {
    fn default() -> Self {
        Self {
            prompt: default_stt_prompt(),
            language_codes: vec!["en".into()],
            sample_rate: 16_000,
            force_endpoint_timeout_ms: 2_500,
            keyterms_limit: 100,
            sync_live: SyncLiveConfig::default(),
            batch: BatchConfig::default(),
        }
    }
}

/// Sync live is the only streaming protocol: Ray's API proxies it to
/// AssemblyAI with the server-side key.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct SyncLiveConfig {
    pub model: String,
    pub max_audio_seconds: u64,
    pub request_timeout_ms: u64,
}

impl Default for SyncLiveConfig {
    fn default() -> Self {
        Self {
            model: "universal-3-5-pro".into(),
            max_audio_seconds: 120,
            request_timeout_ms: 300_000,
        }
    }
}

/// The batch fallbacks: Sync batch first, then Ray's server-side v2 proxy.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct BatchConfig {
    pub model: String,
    pub speech_models: Vec<String>,
    pub timeout_ms: u64,
}

impl Default for BatchConfig {
    fn default() -> Self {
        Self {
            model: "universal-3-5-pro".into(),
            speech_models: vec!["universal-3-5-pro".into(), "universal-2".into()],
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
    /// Hard limit for one provider request (including reading the body).
    #[serde(default = "default_cleanup_timeout_ms")]
    pub timeout_ms: u64,
    /// Fire the fallback in parallel when the primary has not answered by then.
    /// Chosen from the measured p95 primary latency; a warm call is usually 5x
    /// faster, so this only touches the tail.
    #[serde(default = "default_hedge_after_ms")]
    pub hedge_after_ms: u64,
    pub retries: u32,
    pub backoff_ms: Vec<u64>,
    /// Models to try, in order. All of them go to the same Ray cleanup proxy;
    /// a second entry keeps the existing hedge/fallback behavior.
    pub providers: Vec<CleanupProvider>,
}

pub fn default_cleanup_timeout_ms() -> u64 {
    8_000
}

pub fn default_hedge_after_ms() -> u64 {
    4_000
}

impl Default for CleanupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            temperature: 0.0,
            max_tokens: 3_000,
            timeout_ms: default_cleanup_timeout_ms(),
            hedge_after_ms: default_hedge_after_ms(),
            retries: 2,
            backoff_ms: vec![300, 900],
            providers: vec![CleanupProvider {
                id: "ray".into(),
                model: "gemma-4-31b".into(),
                extra_body: None,
            }],
        }
    }
}

/// One cleanup model. The endpoint and auth are fixed by the Ray API; only the
/// model id (passed through verbatim) and an optional extra request body can
/// differ.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CleanupProvider {
    pub id: String,
    pub model: String,
    #[serde(default)]
    pub extra_body: Option<serde_json::Value>,
}

/// Files a user can drop into the app-data directory to override the embedded
/// pipeline without a rebuild.
#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub pipeline: PipelineConfig,
    pub prompt: String,
}

impl RuntimeConfig {
    pub fn load(app_data: &Path) -> Self {
        let pipeline_override = app_data.join("pipeline.json");
        let prompt_override = app_data.join("structured.md");

        let pipeline = match std::fs::read_to_string(&pipeline_override) {
            Ok(text) => match serde_json::from_str::<PipelineConfig>(&text) {
                Ok(config) => config,
                Err(error) => {
                    eprintln!("[ray] ignoring invalid pipeline.json override: {error}");
                    PipelineConfig::default()
                }
            },
            Err(_) => PipelineConfig::default(),
        };

        let prompt = match std::fs::read_to_string(&prompt_override) {
            Ok(text) if !text.trim().is_empty() => text,
            _ => EMBEDDED_PROMPT.to_string(),
        };

        Self { pipeline, prompt }
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
        assert_eq!(config.api.base_url, DEFAULT_API_BASE);
        assert_eq!(config.stt.sync_live.model, "universal-3-5-pro");
        assert_eq!(config.stt.batch.model, "universal-3-5-pro");
        assert_eq!(config.cleanup.providers[0].id, "ray");
        assert_eq!(config.cleanup.providers[0].model, "gemma-4-31b");
        assert_eq!(config.cleanup.providers.len(), 1);
        assert!(config.known_names.iter().any(|name| name == "Helion"));
        assert!(config.known_names.iter().any(|name| name == "GPT-5"));
        assert_eq!(config.cleanup.max_tokens, 3_000);
        assert_eq!(config.cleanup.timeout_ms, 8_000);
        assert_eq!(config.cleanup.hedge_after_ms, 4_000);
        assert!(!EMBEDDED_PROMPT.trim().is_empty());
        assert!(!config.stt.prompt.trim().is_empty());
    }

    #[test]
    fn api_base_comes_from_config_and_the_environment_wins() {
        assert_eq!(
            resolve_api_base("https://ray.helionhq.com", None),
            "https://ray.helionhq.com"
        );
        assert_eq!(
            resolve_api_base("https://ray.helionhq.com/", None),
            "https://ray.helionhq.com"
        );
        assert_eq!(
            resolve_api_base("https://ray.helionhq.com", Some("http://127.0.0.1:8787/")),
            "http://127.0.0.1:8787"
        );
        // Blank values fall through instead of producing an unusable origin.
        assert_eq!(
            resolve_api_base("  https://example.test  ", Some("   ")),
            "https://example.test"
        );
        assert_eq!(resolve_api_base("", None), DEFAULT_API_BASE);
    }

    #[test]
    fn runtime_override_can_set_the_api_origin() {
        let dir = temp_dir("api-base");
        std::fs::write(
            dir.join("pipeline.json"),
            r#"{"api":{"base_url":"http://127.0.0.1:8787"}}"#,
        )
        .unwrap();
        let runtime = RuntimeConfig::load(&dir);
        assert_eq!(runtime.pipeline.api.base_url, "http://127.0.0.1:8787");
        // Everything omitted from the override keeps its embedded default.
        assert_eq!(runtime.pipeline.stt.sync_live.model, "universal-3-5-pro");
        assert_eq!(runtime.pipeline.cleanup.providers[0].model, "gemma-4-31b");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn old_pipeline_overrides_still_load() {
        let dir = temp_dir("legacy-override");
        // Written before the commercial launch: it has the removed STT mode
        // fields, old provider keys, and cleanup modes. Unknown fields are
        // ignored; the parts that still exist are kept.
        std::fs::write(
            dir.join("pipeline.json"),
            r#"{"stt":{"streaming":false,"mode":"websocket","speech_model":"universal-3-6-pro"},
                "cleanup":{"enabled":true,"temperature":0,"max_tokens":1500,
                "timeout_ms":6000,"hedge_after_ms":2500,"retries":2,
                "backoff_ms":[300,900],
                "providers":[{"id":"assemblyai",
                    "base_url":"https://llm-gateway.assemblyai.com/v1",
                    "model":"claude-sonnet-4-5","api_key_secret":"assemblyai"}],
                "modes":{"structured":{"max_tokens":4200}}}}"#,
        )
        .unwrap();

        let runtime = RuntimeConfig::load(&dir);
        assert_eq!(runtime.pipeline.cleanup.max_tokens, 1_500);
        assert_eq!(runtime.pipeline.cleanup.providers[0].id, "assemblyai");
        assert_eq!(
            runtime.pipeline.cleanup.providers[0].model,
            "claude-sonnet-4-5"
        );
        // A missing `api` object gets the default origin.
        assert_eq!(runtime.pipeline.api.base_url, DEFAULT_API_BASE);
        // Removed STT fields are simply absent; the surviving defaults apply.
        assert_eq!(runtime.pipeline.stt.sample_rate, 16_000);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prompt_override_is_structured_md() {
        let dir = temp_dir("prompt");
        std::fs::write(dir.join("structured.md"), "# Structured\n\nNEW PROMPT").unwrap();
        // The retired Clean prompt file is ignored even if an old install left
        // one behind.
        std::fs::write(dir.join("cleanup.md"), "OLD CLEAN PROMPT").unwrap();
        let runtime = RuntimeConfig::load(&dir);
        assert_eq!(runtime.prompt, "# Structured\n\nNEW PROMPT");
        std::fs::remove_dir_all(&dir).ok();

        // With no overrides the embedded prompt is used.
        let runtime = RuntimeConfig::load(&dir);
        assert_eq!(runtime.prompt, EMBEDDED_PROMPT);
    }

    #[test]
    fn an_invalid_override_falls_back_to_the_embedded_config() {
        let dir = temp_dir("invalid");
        std::fs::write(dir.join("pipeline.json"), "not json").unwrap();
        let runtime = RuntimeConfig::load(&dir);
        let defaults = PipelineConfig::default();
        assert_eq!(runtime.pipeline.api.base_url, defaults.api.base_url);
        assert_eq!(
            runtime.pipeline.cleanup.timeout_ms,
            defaults.cleanup.timeout_ms
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
