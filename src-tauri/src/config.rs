//! Pipeline configuration and the cleanup prompts.
//!
//! Both are embedded in the binary but can be overridden at runtime by files in
//! the app-data directory (`pipeline.json`, `cleanup.md`, `structured.md`). This
//! is the one place where models, endpoints, and STT options live. The defaults
//! are the result of `research/final/`: AssemblyAI Sync live STT + a Gemma
//! cleanup pass on the AssemblyAI LLM Gateway.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const EMBEDDED_PIPELINE: &str = include_str!("../config/pipeline.json");
pub const EMBEDDED_PROMPT: &str = include_str!("../prompts/cleanup.md");
pub const EMBEDDED_STRUCTURED_PROMPT: &str = include_str!("../prompts/structured.md");

/// The cleanup pass the user selected. `Clean` is a strict editor; `Structured`
/// may reorder and rephrase so the result reads as finished prose or a list.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CleanupMode {
    #[default]
    Clean,
    Structured,
}

impl CleanupMode {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Structured => "structured",
        }
    }

    /// Unknown or malformed values fall back to `None`; callers use the
    /// default mode so an old or hand-edited settings file never breaks.
    pub fn from_id(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "clean" => Some(Self::Clean),
            "structured" => Some(Self::Structured),
            _ => None,
        }
    }
}

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
    pub providers: Vec<CleanupProvider>,
    /// Per-mode overrides. Unset fields inherit the base cleanup config above.
    #[serde(default)]
    pub modes: CleanupModes,
}

/// Optional overrides for the Structured cleanup mode. The manager/research
/// agent can tune Structured without touching Clean's settings.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CleanupModes {
    pub structured: CleanupModeOverride,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CleanupModeOverride {
    /// Model id passed through verbatim to the first provider (the primary).
    pub model: Option<String>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub timeout_ms: Option<u64>,
    pub hedge_after_ms: Option<u64>,
}

impl CleanupConfig {
    /// The effective config for `mode`. Clean returns an exact clone, so its
    /// request body, limits and timing are byte-for-byte unchanged.
    pub fn for_mode(&self, mode: CleanupMode) -> Self {
        let mut config = self.clone();
        if mode != CleanupMode::Structured {
            return config;
        }
        let overrides = &self.modes.structured;
        if let Some(model) = &overrides.model {
            if let Some(primary) = config.providers.first_mut() {
                // Pass the id through as-is: the AssemblyAI LLM Gateway accepts
                // non-Gemma ids (Claude/GPT/Gemini) on the same endpoint.
                primary.model = model.clone();
            }
        }
        if let Some(temperature) = overrides.temperature {
            config.temperature = temperature;
        }
        if let Some(max_tokens) = overrides.max_tokens {
            config.max_tokens = max_tokens;
        }
        if let Some(timeout_ms) = overrides.timeout_ms {
            config.timeout_ms = timeout_ms;
        }
        if let Some(hedge_after_ms) = overrides.hedge_after_ms {
            config.hedge_after_ms = hedge_after_ms;
        }
        config
    }
}

pub fn default_cleanup_timeout_ms() -> u64 {
    6_000
}

pub fn default_hedge_after_ms() -> u64 {
    2_500
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
                id: "assemblyai".into(),
                base_url: "https://llm-gateway.assemblyai.com/v1".into(),
                model: "gemma-4-31b".into(),
                api_key_secret: "assemblyai".into(),
                extra_body: None,
            }],
            modes: CleanupModes::default(),
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

/// The prompt template that belongs to `mode`. Clean keeps using `cleanup.md`;
/// Structured uses `structured.md`.
pub fn prompt_for<'a>(clean: &'a str, structured: &'a str, mode: CleanupMode) -> &'a str {
    match mode {
        CleanupMode::Clean => clean,
        CleanupMode::Structured => structured,
    }
}

/// Files a user (or the research agent) can drop into the app-data directory to
/// override the embedded pipeline without a rebuild.
#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub pipeline: PipelineConfig,
    pub prompt: String,
    pub structured_prompt: String,
}

/// Whether a raw `pipeline.json` document explicitly contains `cleanup.modes`.
/// This distinguishes an older override that predates the key (which must get
/// the embedded Structured defaults) from an explicit, possibly partial object
/// (which must keep inheriting the override's base cleanup values).
fn has_cleanup_modes(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    value
        .get("cleanup")
        .and_then(|cleanup| cleanup.get("modes"))
        .is_some()
}

impl RuntimeConfig {
    pub fn load(app_data: &Path) -> Self {
        let pipeline_override = app_data.join("pipeline.json");
        let prompt_override = app_data.join("cleanup.md");
        let structured_override = app_data.join("structured.md");

        let pipeline = match std::fs::read_to_string(&pipeline_override) {
            Ok(text) => match serde_json::from_str::<PipelineConfig>(&text) {
                Ok(mut config) => {
                    // Overrides written before Structured existed have no
                    // `cleanup.modes`, so without this they would lose the
                    // embedded 8000 ms timeout / 4000 ms hedge defaults. Keep
                    // `model: None` so Structured inherits the user's own base
                    // primary model instead of the embedded one.
                    if !has_cleanup_modes(&text) {
                        let defaults = PipelineConfig::default().cleanup.modes;
                        config.cleanup.modes = CleanupModes {
                            structured: CleanupModeOverride {
                                model: None,
                                ..defaults.structured
                            },
                        };
                    }
                    config
                }
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

        let structured_prompt = match std::fs::read_to_string(&structured_override) {
            Ok(text) if !text.trim().is_empty() => text,
            _ => EMBEDDED_STRUCTURED_PROMPT.to_string(),
        };

        Self {
            pipeline,
            prompt,
            structured_prompt,
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
        assert_eq!(config.cleanup.providers.len(), 1);
        assert!(config.cleanup.providers.iter().all(|p| p.id != "vercel"));
        assert!(config.known_names.iter().any(|name| name == "Helion"));
        assert!(config.known_names.iter().any(|name| name == "GPT-5"));
        assert_eq!(config.cleanup.max_tokens, 3_000);
        assert_eq!(config.cleanup.timeout_ms, 6_000);
        assert_eq!(config.cleanup.hedge_after_ms, 2_500);
        // Structured's researched overrides are in the embedded config, while
        // Clean's effective config stays exactly the base values.
        let structured = config.cleanup.for_mode(CleanupMode::Structured);
        assert_eq!(structured.providers[0].model, "gemma-4-31b");
        assert_eq!(structured.temperature, 0.0);
        assert_eq!(structured.max_tokens, 3_000);
        assert_eq!(structured.timeout_ms, 8_000);
        assert_eq!(structured.hedge_after_ms, 4_000);
        let clean = config.cleanup.for_mode(CleanupMode::Clean);
        assert_eq!(clean.timeout_ms, 6_000);
        assert_eq!(clean.hedge_after_ms, 2_500);
        assert!(config.known_names.iter().any(|name| name == "gpt-oss"));
        assert!(!EMBEDDED_PROMPT.trim().is_empty());
        assert!(!EMBEDDED_STRUCTURED_PROMPT.trim().is_empty());
    }

    #[test]
    fn cleanup_mode_defaults_to_clean_and_parses_known_ids() {
        assert_eq!(CleanupMode::default(), CleanupMode::Clean);
        assert_eq!(CleanupMode::from_id(" Clean "), Some(CleanupMode::Clean));
        assert_eq!(
            CleanupMode::from_id("STRUCTURED"),
            Some(CleanupMode::Structured)
        );
        assert_eq!(CleanupMode::from_id("rewrite"), None);
        assert_eq!(CleanupMode::Clean.id(), "clean");
        assert_eq!(CleanupMode::Structured.id(), "structured");
    }

    #[test]
    fn structured_overrides_inherit_unset_fields() {
        let cleanup: CleanupConfig = serde_json::from_str(
            r#"{"enabled":true,"temperature":0,"max_tokens":3000,"timeout_ms":6000,
                "hedge_after_ms":2500,"retries":2,"backoff_ms":[300,900],
                "providers":[{"id":"assemblyai",
                    "base_url":"https://llm-gateway.assemblyai.com/v1",
                    "model":"gemma-4-31b","api_key_secret":"assemblyai"}],
                "modes":{"structured":{"max_tokens":4200}}}"#,
        )
        .unwrap();

        // Clean is an exact clone: no override may leak into it.
        let clean = cleanup.for_mode(CleanupMode::Clean);
        assert_eq!(clean.temperature, 0.0);
        assert_eq!(clean.max_tokens, 3_000);
        assert_eq!(clean.providers[0].model, "gemma-4-31b");
        assert_eq!(clean.timeout_ms, 6_000);
        assert_eq!(clean.hedge_after_ms, 2_500);

        // Only the field the override names changes; everything else inherits.
        let structured = cleanup.for_mode(CleanupMode::Structured);
        assert_eq!(structured.temperature, 0.0);
        assert_eq!(structured.max_tokens, 4_200);
        assert_eq!(structured.providers[0].model, "gemma-4-31b");
        assert_eq!(structured.timeout_ms, 6_000);
        assert_eq!(structured.hedge_after_ms, 2_500);
    }

    #[test]
    fn structured_model_override_is_passed_through_verbatim() {
        let cleanup: CleanupConfig = serde_json::from_str(
            r#"{"enabled":true,"temperature":0,"max_tokens":3000,"retries":2,
                "backoff_ms":[300,900],
                "providers":[{"id":"assemblyai",
                    "base_url":"https://llm-gateway.assemblyai.com/v1",
                    "model":"gemma-4-31b","api_key_secret":"assemblyai"}],
                "modes":{"structured":{"model":"claude-sonnet-4-5",
                    "temperature":0.2,"timeout_ms":9000,"hedge_after_ms":3000}}}"#,
        )
        .unwrap();
        let structured = cleanup.for_mode(CleanupMode::Structured);
        // Non-Gemma gateway ids are not rewritten or rejected.
        assert_eq!(structured.providers[0].model, "claude-sonnet-4-5");
        assert_eq!(structured.temperature, 0.2);
        assert_eq!(structured.timeout_ms, 9_000);
        assert_eq!(structured.hedge_after_ms, 3_000);
        assert_eq!(structured.max_tokens, 3_000);
    }

    #[test]
    fn clean_selects_the_clean_prompt_and_structured_the_other() {
        // Clean's prompt source must be exactly the old one.
        assert_eq!(
            prompt_for("clean prompt", "structured prompt", CleanupMode::Clean),
            "clean prompt"
        );
        assert_eq!(
            prompt_for(
                EMBEDDED_PROMPT,
                EMBEDDED_STRUCTURED_PROMPT,
                CleanupMode::Clean
            ),
            EMBEDDED_PROMPT
        );
        assert_eq!(
            prompt_for(
                EMBEDDED_PROMPT,
                EMBEDDED_STRUCTURED_PROMPT,
                CleanupMode::Structured
            ),
            EMBEDDED_STRUCTURED_PROMPT
        );
    }

    #[test]
    fn runtime_overrides_load_each_prompt_independently() {
        let dir = std::env::temp_dir().join(format!("ray-config-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cleanup.md"), "# Clean\n\nCLEAN PROMPT").unwrap();
        std::fs::write(
            dir.join("structured.md"),
            "# Structured\n\nSTRUCTURED PROMPT",
        )
        .unwrap();
        let runtime = RuntimeConfig::load(&dir);
        assert_eq!(runtime.prompt, "# Clean\n\nCLEAN PROMPT");
        assert_eq!(
            runtime.structured_prompt,
            "# Structured\n\nSTRUCTURED PROMPT"
        );
        std::fs::remove_dir_all(&dir).ok();

        // With no overrides both fall back to the embedded prompts.
        let runtime = RuntimeConfig::load(&dir);
        assert_eq!(runtime.prompt, EMBEDDED_PROMPT);
        assert_eq!(runtime.structured_prompt, EMBEDDED_STRUCTURED_PROMPT);
    }

    #[test]
    fn older_cleanup_overrides_get_the_hedge_defaults() {
        // A user's app-data pipeline.json written before hedging existed must
        // still load, with sensible timeout defaults rather than zero.
        let cleanup: CleanupConfig = serde_json::from_str(
            r#"{"enabled":true,"temperature":0,"max_tokens":1500,"retries":2,
                "backoff_ms":[300,900],"providers":[]}"#,
        )
        .unwrap();
        assert_eq!(cleanup.timeout_ms, 6_000);
        assert_eq!(cleanup.hedge_after_ms, 2_500);
        // A document written before modes existed still loads.
        assert_eq!(cleanup.modes.structured.model, None);
    }

    #[test]
    fn override_without_modes_gets_embedded_structured_defaults() {
        let dir = std::env::temp_dir().join(format!(
            "ray-config-test-legacy-modes-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // A pipeline.json written before Structured existed has no modes key.
        // It uses a custom primary model, which Structured must inherit.
        std::fs::write(
            dir.join("pipeline.json"),
            r#"{"stt":{},"cleanup":{"enabled":true,"temperature":0,
                "max_tokens":1500,"retries":2,"backoff_ms":[300,900],
                "providers":[{"id":"assemblyai",
                    "base_url":"https://llm-gateway.assemblyai.com/v1",
                    "model":"claude-sonnet-4-5","api_key_secret":"assemblyai"}]}}"#,
        )
        .unwrap();

        let runtime = RuntimeConfig::load(&dir);
        let structured = runtime.pipeline.cleanup.for_mode(CleanupMode::Structured);
        assert_eq!(structured.providers[0].model, "claude-sonnet-4-5");
        assert_eq!(structured.temperature, 0.0);
        assert_eq!(structured.max_tokens, 3_000);
        assert_eq!(structured.timeout_ms, 8_000);
        assert_eq!(structured.hedge_after_ms, 4_000);

        // Clean still inherits the override's own base values, untouched.
        let clean = runtime.pipeline.cleanup.for_mode(CleanupMode::Clean);
        assert_eq!(clean.providers[0].model, "claude-sonnet-4-5");
        assert_eq!(clean.max_tokens, 1_500);
        assert_eq!(clean.timeout_ms, 6_000);
        assert_eq!(clean.hedge_after_ms, 2_500);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn explicit_partial_modes_keep_base_cleanup_inheritance() {
        let dir = std::env::temp_dir().join(format!(
            "ray-config-test-partial-modes-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("pipeline.json"),
            r#"{"stt":{},"cleanup":{"enabled":true,"temperature":0,
                "max_tokens":1500,"retries":2,"backoff_ms":[300,900],
                "providers":[],
                "modes":{"structured":{"max_tokens":4200}}}}"#,
        )
        .unwrap();

        let runtime = RuntimeConfig::load(&dir);
        let structured = runtime.pipeline.cleanup.for_mode(CleanupMode::Structured);
        // The explicit field wins; the rest inherit the base cleanup config,
        // not the embedded Structured defaults.
        assert_eq!(structured.max_tokens, 4_200);
        assert_eq!(structured.timeout_ms, 6_000);
        assert_eq!(structured.hedge_after_ms, 2_500);

        let clean = runtime.pipeline.cleanup.for_mode(CleanupMode::Clean);
        assert_eq!(clean.max_tokens, 1_500);
        assert_eq!(clean.timeout_ms, 6_000);
        assert_eq!(clean.hedge_after_ms, 2_500);
        std::fs::remove_dir_all(&dir).ok();
    }
}
