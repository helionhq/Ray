//! The LLM cleanup pass.
//!
//! Any OpenAI-compatible `/chat/completions` endpoint works. Providers are
//! tried in the order in `pipeline.json`, skipping any without a stored key;
//! the first valid answer wins. If every provider fails, the raw transcript is
//! used so dictation never silently drops the user's words.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::config::{CleanupConfig, CleanupProvider};
use crate::secrets;

#[derive(Debug, Clone)]
pub struct CleanupResult {
    pub text: String,
    pub provider: Option<String>,
    pub note: Option<String>,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChatMessage,
}

#[derive(Deserialize)]
struct ChatMessage {
    #[serde(default)]
    content: Option<String>,
}

pub fn build_system_prompt(
    template: &str,
    dictionary: &[String],
    known_names: &[String],
    app_name: &str,
) -> String {
    let dictionary = if dictionary.is_empty() {
        "(none yet — preserve the speaker's spelling)".to_string()
    } else {
        dictionary.join(", ")
    };
    let known_names = if known_names.is_empty() {
        "(none)".to_string()
    } else {
        known_names.join(", ")
    };
    template
        .replace("{{DICTIONARY}}", &dictionary)
        .replace("{{KNOWN_NAMES}}", &known_names)
        .replace("{{APP_NAME}}", app_name)
        .replace("{{TRANSCRIPT}}", "(the transcript)")
}

pub async fn cleanup(
    http: &reqwest::Client,
    config: &CleanupConfig,
    prompt_template: &str,
    transcript: &str,
    dictionary: &[String],
    known_names: &[String],
    app_name: &str,
) -> CleanupResult {
    let transcript = transcript.trim();
    if transcript.is_empty() {
        return CleanupResult {
            text: String::new(),
            provider: None,
            note: None,
        };
    }
    let mut notes = Vec::new();
    let system = build_system_prompt(prompt_template, dictionary, known_names, app_name);

    for provider in &config.providers {
        let Some(key) = secrets::get(&provider.api_key_secret) else {
            continue;
        };
        match call_provider(http, provider, &key, config, &system, transcript).await {
            Ok(text) => {
                if is_plausible(&text, transcript) {
                    return CleanupResult {
                        text,
                        provider: Some(provider.id.clone()),
                        note: None,
                    };
                }
                notes.push(format!("{}: response rejected", provider.id));
            }
            Err(error) => notes.push(format!("{}: {error}", provider.id)),
        }
    }

    CleanupResult {
        text: transcript.to_string(),
        provider: None,
        note: if notes.is_empty() {
            Some("No cleanup provider is configured; using the raw transcript".into())
        } else {
            Some(format!(
                "Cleanup failed ({}); using the raw transcript",
                notes.join("; ")
            ))
        },
    }
}

async fn call_provider(
    http: &reqwest::Client,
    provider: &CleanupProvider,
    key: &str,
    config: &CleanupConfig,
    system: &str,
    transcript: &str,
) -> Result<String, String> {
    let url = format!(
        "{}/chat/completions",
        provider.base_url.trim_end_matches('/')
    );
    let mut body = Map::new();
    body.insert("model".into(), json!(provider.model));
    body.insert(
        "messages".into(),
        json!([
            { "role": "system", "content": system },
            {
                "role": "user",
                "content": format!("<transcript>\n{transcript}\n</transcript>")
            }
        ]),
    );
    body.insert("temperature".into(), json!(config.temperature));
    body.insert("max_tokens".into(), json!(config.max_tokens));
    body.insert("stream".into(), json!(false));
    if let Some(Value::Object(extra)) = &provider.extra_body {
        for (key, value) in extra {
            body.insert(key.clone(), value.clone());
        }
    }
    let body = Value::Object(body);
    let attempts = config.retries.saturating_add(1).max(1);

    for attempt in 0..attempts {
        let response = tokio::time::timeout(
            Duration::from_millis(config.timeout_ms.max(1_000)),
            http.post(&url)
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .json(&body)
                .send(),
        )
        .await;
        let response = match response {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                if attempt + 1 < attempts {
                    backoff(config, attempt).await;
                    continue;
                }
                return Err(format!("request failed: {error}"));
            }
            Err(_) => return Err("timed out".into()),
        };

        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| format!("could not read the response: {error}"))?;
        if !status.is_success() {
            let message = api_message(&text);
            let retryable = matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504);
            if retryable && attempt + 1 < attempts {
                backoff(config, attempt).await;
                continue;
            }
            return Err(format!("HTTP {status}: {message}"));
        }

        let parsed: ChatResponse = serde_json::from_str(&text)
            .map_err(|error| format!("invalid response JSON: {error}"))?;
        let content = parsed
            .choices
            .into_iter()
            .next()
            .and_then(|choice| choice.message.content)
            .ok_or_else(|| "the model returned no text".to_string())?;
        let cleaned = sanitize(&content);
        if cleaned.is_empty() {
            return Err("the model returned an empty answer".into());
        }
        return Ok(cleaned);
    }
    Err("no attempt succeeded".into())
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
        .unwrap_or_else(|| trimmed.chars().take(200).collect())
}

async fn backoff(config: &CleanupConfig, attempt: u32) {
    let delay = config
        .backoff_ms
        .get(attempt as usize)
        .copied()
        .unwrap_or(900);
    tokio::time::sleep(Duration::from_millis(delay)).await;
}

/// Remove a wrapping code fence or a pair of surrounding straight quotes that
/// models sometimes add despite instruction. Does not touch interior text.
fn sanitize(content: &str) -> String {
    let mut text = content.trim().to_string();
    if text.starts_with("```") {
        if let Some(first_newline) = text.find('\n') {
            text = text[first_newline + 1..].to_string();
        }
        if text.ends_with("```") {
            text.truncate(text.len() - 3);
        }
        text = text.trim().to_string();
    }
    if let Some(inner) = text
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .or_else(|| text.strip_prefix('“').and_then(|rest| rest.strip_suffix('”')))
    {
        if !inner.contains('"') && !inner.contains('“') {
            text = inner.trim().to_string();
        }
    }
    text
}

/// A cleanup answer must stay in the same neighborhood as what was said.
/// This catches refusals, explanations, and models that answer a question.
fn is_plausible(cleaned: &str, transcript: &str) -> bool {
    let cleaned_len = cleaned.chars().count();
    let transcript_len = transcript.chars().count();
    if cleaned_len == 0 {
        return false;
    }
    if cleaned_len > 40 && cleaned_len > transcript_len * 4 {
        return false;
    }
    // Cleanup shortens or keeps length; it should not balloon a fragment.
    if transcript_len <= 12 && cleaned_len > 80 {
        return false;
    }
    // Cleanup shortens a little (fillers, self-corrections), but a long
    // transcript that loses most of its content is a bad answer, not cleanup.
    if transcript_len > 200 && cleaned_len * 3 < transcript_len {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dictionary_and_app_are_substituted() {
        let prompt = build_system_prompt(
            "Words: {{DICTIONARY}}. Names: {{KNOWN_NAMES}}. App: {{APP_NAME}}. {{TRANSCRIPT}}",
            &["Helion HQ".into(), "Kubernetes".into()],
            &["Ray".into(), "Tauri".into()],
            "Notepad",
        );
        assert_eq!(
            prompt,
            "Words: Helion HQ, Kubernetes. Names: Ray, Tauri. App: Notepad. (the transcript)"
        );
    }

    #[test]
    fn strips_code_fences_and_quotes() {
        assert_eq!(sanitize("```text\nHello there.\n```"), "Hello there.");
        assert_eq!(sanitize("\"Hello there.\""), "Hello there.");
        assert_eq!(sanitize("“Hello there.”"), "Hello there.");
        assert_eq!(
            sanitize("He said \"hello\" to me."),
            "He said \"hello\" to me."
        );
    }

    #[test]
    fn rejects_ballooned_answers() {
        assert!(is_plausible(
            "Ship it Friday.",
            "so should we ship it friday"
        ));
        assert!(!is_plausible(&"x".repeat(400), "yes"));
    }
}
