//! The LLM cleanup pass.
//!
//! Any OpenAI-compatible `/chat/completions` endpoint works. Providers are
//! tried in the order in `pipeline.json`, skipping any without a stored key;
//! the first valid answer wins. If every provider fails, the raw transcript is
//! used so dictation never silently drops the user's words.

use std::future::Future;
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
        "(none)".to_string()
    } else {
        dictionary.join(", ")
    };
    let known_names = if known_names.is_empty() {
        "(none)".to_string()
    } else {
        known_names.join(", ")
    };
    strip_markdown_title(template)
        .replace("{{DICTIONARY}}", &dictionary)
        .replace("{{KNOWN_NAMES}}", &known_names)
        .replace("{{APP_NAME}}", app_name)
        .replace("{{TRANSCRIPT}}", "(the transcript)")
}

/// The checked-in prompt file starts with a Markdown title written for people
/// reading the repo. Research stripped it before sending; sending it makes the
/// model think it is looking at a document rather than plain instructions.
fn strip_markdown_title(template: &str) -> &str {
    let text = template.strip_prefix('\u{feff}').unwrap_or(template);
    let trimmed_start = text.trim_start_matches(['\r', '\n']);
    if !trimmed_start.starts_with('#') {
        return trimmed_start;
    }
    match trimmed_start.find('\n') {
        Some(newline) => trimmed_start[newline + 1..].trim_start_matches(['\r', '\n']),
        None => "",
    }
}

/// Open DNS/TCP/TLS to the cleanup gateway while the user is still speaking.
/// The first dictation otherwise pays the cold-connection handshake after the
/// hotkey is released. The response is irrelevant; any completed request leaves
/// the connection in the pool.
pub async fn warm_connection(http: &reqwest::Client, config: &CleanupConfig) {
    for provider in &config.providers {
        let Some(key) = secrets::get(&provider.api_key_secret) else {
            continue;
        };
        let url = format!("{}/models", provider.base_url.trim_end_matches('/'));
        if let Ok(response) = http
            .get(&url)
            .header("authorization", format!("Bearer {key}"))
            .timeout(Duration::from_secs(5))
            .send()
            .await
        {
            // Drain the body so the connection returns to the pool; dropping
            // an unread response makes hyper close it instead.
            let _ = response.bytes().await;
        }
        return;
    }
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
    let system = build_system_prompt(prompt_template, dictionary, known_names, app_name);
    let mut providers = config
        .providers
        .iter()
        .filter_map(|provider| secrets::get(&provider.api_key_secret).map(|key| (provider, key)));

    let Some((primary, primary_key)) = providers.next() else {
        return CleanupResult {
            text: transcript.to_string(),
            provider: None,
            note: Some("No cleanup provider is configured; using the raw transcript".into()),
        };
    };
    let fallback = providers.next();
    let fallback_id = fallback.as_ref().map(|(provider, _)| provider.id.clone());
    let accept = |text: &str| is_plausible(text, transcript);
    let hedge_after = Duration::from_millis(config.hedge_after_ms.max(1));
    let primary_call = call_provider(http, primary, &primary_key, config, &system, transcript);

    let outcome = if let Some((fallback, fallback_key)) = fallback {
        run_hedged(
            hedge_after,
            primary_call,
            Some(call_provider(
                http,
                fallback,
                &fallback_key,
                config,
                &system,
                transcript,
            )),
            accept,
        )
        .await
    } else {
        match primary_call.await {
            Ok(text) if accept(&text) => Ok((text, true)),
            Ok(_) => Err((Some("response rejected".to_string()), None)),
            Err(error) => Err((Some(error), None)),
        }
    };

    match outcome {
        Ok((text, true)) => CleanupResult {
            text,
            provider: Some(primary.id.clone()),
            note: None,
        },
        Ok((text, false)) => CleanupResult {
            text,
            provider: fallback_id,
            note: None,
        },
        Err((primary_error, fallback_error)) => {
            let mut notes = Vec::new();
            if let Some(error) = primary_error {
                notes.push(format!("{}: {error}", primary.id));
            }
            if let (Some(id), Some(error)) = (&fallback_id, fallback_error) {
                notes.push(format!("{id}: {error}"));
            }
            // Unusual configs may list more than two providers; try them in
            // order only after the hedged pair has failed.
            for (provider, key) in providers {
                match call_provider(http, provider, &key, config, &system, transcript).await {
                    Ok(text) if is_plausible(&text, transcript) => {
                        return CleanupResult {
                            text,
                            provider: Some(provider.id.clone()),
                            note: None,
                        }
                    }
                    Ok(_) => notes.push(format!("{}: response rejected", provider.id)),
                    Err(error) => notes.push(format!("{}: {error}", provider.id)),
                }
            }
            CleanupResult {
                text: transcript.to_string(),
                provider: None,
                note: Some(format!(
                    "Cleanup failed ({}); using the raw transcript",
                    notes.join("; ")
                )),
            }
        }
    }
}

/// Race the primary against a fallback that is only launched once the primary
/// has been silent for `hedge_after` (or has already failed). The first answer
/// that passes `accept` wins; the losing request is dropped, which cancels it.
///
/// Returns `(text, from_primary)` on success, or the two provider errors. The
/// fallback is lazy: when the primary answers inside the hedge window it is
/// never polled, so a Groq 429 cannot touch the primary path.
async fn run_hedged<P, F>(
    hedge_after: Duration,
    primary: P,
    fallback: Option<F>,
    accept: impl Fn(&str) -> bool,
) -> Result<(String, bool), (Option<String>, Option<String>)>
where
    P: Future<Output = Result<String, String>>,
    F: Future<Output = Result<String, String>>,
{
    let mut primary = Box::pin(primary);
    let mut primary_done = false;
    let mut primary_error = None;

    let Some(mut fallback) = fallback.map(Box::pin) else {
        return match primary.await {
            Ok(text) if accept(&text) => Ok((text, true)),
            Ok(_) => Err((Some("response rejected".into()), None)),
            Err(error) => Err((Some(error), None)),
        };
    };

    let hedge = tokio::time::sleep(hedge_after);
    tokio::pin!(hedge);
    tokio::select! {
        result = &mut primary => {
            primary_done = true;
            match result {
                Ok(text) if accept(&text) => return Ok((text, true)),
                Ok(_) => primary_error = Some("response rejected".into()),
                Err(error) => primary_error = Some(error),
            }
        }
        _ = &mut hedge => {}
    }

    let mut fallback_done = false;
    let mut fallback_error = None;
    while !(primary_done && fallback_done) {
        tokio::select! {
            result = &mut primary, if !primary_done => {
                primary_done = true;
                match result {
                    Ok(text) if accept(&text) => return Ok((text, true)),
                    Ok(_) => primary_error = Some("response rejected".into()),
                    Err(error) => primary_error = Some(error),
                }
            }
            result = &mut fallback, if !fallback_done => {
                fallback_done = true;
                match result {
                    Ok(text) if accept(&text) => return Ok((text, false)),
                    Ok(_) => fallback_error = Some("response rejected".into()),
                    Err(error) => fallback_error = Some(error),
                }
            }
        }
    }
    Err((primary_error, fallback_error))
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
        // The timeout covers sending *and* reading the body. Wrapping only
        // `send()` left a stalled stream able to outlive the timeout.
        let response = tokio::time::timeout(
            Duration::from_millis(config.timeout_ms.max(1_000)),
            async {
                let response = http
                    .post(&url)
                    .header("authorization", format!("Bearer {key}"))
                    .header("content-type", "application/json")
                    .json(&body)
                    .send()
                    .await?;
                let status = response.status();
                let text = response.text().await?;
                Ok::<_, reqwest::Error>((status, text))
            },
        )
        .await;
        let (status, text) = match response {
            Ok(Ok(pair)) => pair,
            Ok(Err(error)) => {
                if attempt + 1 < attempts {
                    backoff(config, attempt).await;
                    continue;
                }
                return Err(format!("request failed: {error}"));
            }
            Err(_) => return Err("timed out".into()),
        };
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

/// STT occasionally emits U+FFFD or control characters where punctuation was
/// unclear. They are safe to drop; leaving them in can reach the clipboard on a
/// cleanup failure and makes prompts noisy.
pub fn sanitize_transcript(text: &str) -> String {
    let text = scrub_replacement_chars(text);
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '\u{0000}'..='\u{0008}' | '\u{000B}' | '\u{000C}' | '\u{000E}'..='\u{001F}' => {}
            _ => out.push(character),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Replace U+FFFD where a model or decoder lost a punctuation character. The
/// replacement is comma-and-space between words ("tight�we" -> "tight, we")
/// and nothing elsewhere, so no character reaches the clipboard.
fn scrub_replacement_chars(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '\u{FFFD}' {
            out.push(character);
            continue;
        }
        let previous_is_word = out.chars().next_back().is_some_and(char::is_alphanumeric);
        let next_character = characters.peek().copied();
        let next_is_word = characters
            .clone()
            .find(|candidate| !candidate.is_whitespace())
            .is_some_and(char::is_alphanumeric);
        if previous_is_word && next_is_word {
            out.push(',');
            if next_character.is_some_and(|next| !next.is_whitespace()) {
                out.push(' ');
            }
        }
    }
    out
}

/// Remove a wrapping code fence or a pair of surrounding straight quotes that
/// models sometimes add despite instruction. Does not touch interior text.
fn sanitize(content: &str) -> String {
    let mut text = scrub_replacement_chars(content.trim());
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

const GREETINGS: [&str; 8] = ["yo", "hey", "hi", "hello", "sup", "howdy", "morning", "evening"];
const ADDED_CONNECTIVES: [&str; 8] = [
    "because",
    "since",
    "therefore",
    "thus",
    "so that",
    "which means",
    "also",
    "however",
];
const INFORMAL_FORMS: [(&str, &str); 6] = [
    ("wanna", "want to"),
    ("gonna", "going to"),
    ("gotta", "got to"),
    ("kinda", "kind of"),
    ("sorta", "sort of"),
    ("yeah", "yes"),
];

fn first_word(text: &str) -> Option<String> {
    text.split_whitespace().next().map(|word| {
        word.trim_matches(|character: char| !character.is_alphanumeric())
            .to_lowercase()
    })
}

/// Word-boundary check. Phrases (with a space) use a simple substring test.
fn contains_word(text: &str, needle: &str) -> bool {
    if needle.chars().any(char::is_whitespace) {
        return text.to_lowercase().contains(needle);
    }
    text.split(|character: char| !character.is_alphanumeric() && character != '\'')
        .any(|word| word.eq_ignore_ascii_case(needle))
}

/// "Yo" -> "Hey" is a tone change, not a cleanup. The manager found this in
/// round 1; the guard makes it impossible even if a model ignores the prompt.
fn swaps_greeting(cleaned: &str, transcript: &str) -> bool {
    let (Some(original), Some(replacement)) = (first_word(transcript), first_word(cleaned)) else {
        return false;
    };
    GREETINGS.contains(&original.as_str())
        && GREETINGS.contains(&replacement.as_str())
        && original != replacement
}

/// Cleanup may delete words, not add causal/linking words. The manager's
/// example: "needs a pass. It's too wordy" became "needs a pass because ...".
fn adds_connective(cleaned: &str, transcript: &str) -> bool {
    ADDED_CONNECTIVES
        .iter()
        .any(|word| contains_word(cleaned, word) && !contains_word(transcript, word))
}

/// True when the text states a clock time with a.m./p.m. ("3:30 PM", "3pm",
/// "3 p.m."), not merely the word "am" in "I am".
fn has_meridiem(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.contains("a.m.") || lower.contains("p.m.") {
        return true;
    }
    fn token(word: &str) -> &str {
        word.trim_matches(|character: char| !character.is_ascii_alphanumeric())
    }
    let words: Vec<&str> = lower.split_whitespace().collect();
    words.iter().any(|word| {
        let word = token(word);
        (word.ends_with("am") || word.ends_with("pm"))
            && word.chars().any(|character| character.is_ascii_digit())
    }) || words.windows(2).any(|pair| {
        let next = token(pair[1]);
        (next == "am" || next == "pm")
            && pair[0].chars().any(|character| character.is_ascii_digit())
    })
}

/// The model must not invent a time of day. "Thursday at 3:30" became "3:30
/// p.m." in round 2; only allow the marker when the speaker supplied it or a
/// time-of-day word that justifies it.
fn adds_meridiem(cleaned: &str, transcript: &str) -> bool {
    if !has_meridiem(cleaned) || has_meridiem(transcript) {
        return false;
    }
    const CUES: [&str; 9] = [
        "morning",
        "afternoon",
        "evening",
        "night",
        "noon",
        "midnight",
        "tonight",
        "a.m.",
        "p.m.",
    ];
    !CUES
        .iter()
        .any(|cue| contains_word(transcript, cue))
}

/// "Goff reply" became "Gough replied" in round 1: the model invented a person.
/// If the output attributes speech to a name the transcript never contains,
/// reject it.
fn invents_speaker(cleaned: &str, transcript: &str) -> bool {
    const VERBS: [&str; 6] = ["replied", "said", "asked", "wrote", "added", "mentioned"];
    let words: Vec<&str> = cleaned.split_whitespace().collect();
    words.windows(2).any(|pair| {
        let name = pair[0].trim_matches(|character: char| !character.is_alphabetic());
        let verb = pair[1]
            .trim_matches(|character: char| !character.is_alphabetic())
            .to_lowercase();
        name.chars().next().is_some_and(char::is_uppercase)
            && VERBS.contains(&verb.as_str())
            && !contains_word(transcript, name)
    })
}

/// "Hey, ClickOne" is the phrase "quick one", not the model Qwen. Adding Qwen
/// to the known names made the model map the sound to a product; this guard
/// keeps the ordinary phrase ordinary. A real "Quen" from ASR is still allowed
/// to become "Qwen".
fn invents_qwen(cleaned: &str, transcript: &str) -> bool {
    contains_word(cleaned, "Qwen")
        && !contains_word(transcript, "qwen")
        && !contains_word(transcript, "quen")
        && !contains_word(transcript, "kuen")
}

/// Keep casual forms casual: "wanna" must not become "want to".
fn expands_informal(cleaned: &str, transcript: &str) -> bool {
    INFORMAL_FORMS.iter().any(|(informal, formal)| {
        contains_word(transcript, informal)
            && !contains_word(cleaned, informal)
            && contains_word(cleaned, formal)
    })
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
    // Cleanup shortens (fillers, repeated false starts, self-corrections). A
    // rambling 250-character transcript can legitimately shrink by 70%, so
    // only reject when more than three quarters of the content is gone.
    if transcript_len > 200 && cleaned_len * 4 < transcript_len {
        return false;
    }
    if swaps_greeting(cleaned, transcript)
        || adds_connective(cleaned, transcript)
        || expands_informal(cleaned, transcript)
        || adds_meridiem(cleaned, transcript)
        || invents_speaker(cleaned, transcript)
        || invents_qwen(cleaned, transcript)
    {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    #[tokio::test]
    async fn hedge_does_not_launch_the_fallback_when_the_primary_is_fast() {
        let fallback_polled = Arc::new(AtomicBool::new(false));
        let flag = fallback_polled.clone();
        let primary = async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            Ok::<String, String>("primary".into())
        };
        let fallback = async move {
            flag.store(true, Ordering::SeqCst);
            Ok::<String, String>("fallback".into())
        };
        let result = run_hedged(Duration::from_millis(50), primary, Some(fallback), |_| true)
            .await
            .unwrap();
        assert_eq!(result, ("primary".to_string(), true));
        assert!(!fallback_polled.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn hedge_takes_the_fast_fallback_when_the_primary_is_slow() {
        let started = Instant::now();
        let primary = async {
            tokio::time::sleep(Duration::from_millis(250)).await;
            Ok::<String, String>("primary".into())
        };
        let fallback = async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            Ok::<String, String>("fallback".into())
        };
        let (text, from_primary) =
            run_hedged(Duration::from_millis(20), primary, Some(fallback), |_| true)
                .await
                .unwrap();
        assert_eq!(text, "fallback");
        assert!(!from_primary);
        assert!(started.elapsed() < Duration::from_millis(150));
    }

    #[tokio::test]
    async fn a_primary_error_fires_the_fallback_without_waiting_for_the_hedge() {
        let started = Instant::now();
        let primary = async { Err::<String, String>("boom".into()) };
        let fallback = async { Ok::<String, String>("fallback".into()) };
        let (text, from_primary) =
            run_hedged(Duration::from_millis(500), primary, Some(fallback), |_| true)
                .await
                .unwrap();
        assert_eq!(text, "fallback");
        assert!(!from_primary);
        assert!(started.elapsed() < Duration::from_millis(100));
    }

    #[tokio::test]
    async fn an_invalid_primary_answer_is_skipped_for_a_valid_fallback() {
        let primary = async { Ok::<String, String>("Hey, quick one.".into()) };
        let fallback = async { Ok::<String, String>("Yo, quick one.".into()) };
        let (text, from_primary) = run_hedged(
            Duration::from_millis(50),
            primary,
            Some(fallback),
            |text| text == "Yo, quick one.",
        )
        .await
        .unwrap();
        assert_eq!(text, "Yo, quick one.");
        assert!(!from_primary);
    }

    #[tokio::test]
    async fn the_primary_can_still_win_after_the_hedge_fires() {
        let primary = async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            Ok::<String, String>("primary".into())
        };
        let fallback = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            Ok::<String, String>("fallback".into())
        };
        let (text, from_primary) =
            run_hedged(Duration::from_millis(5), primary, Some(fallback), |_| true)
                .await
                .unwrap();
        assert_eq!(text, "primary");
        assert!(from_primary);
    }

    #[tokio::test]
    async fn both_failures_are_reported() {
        let primary = async { Err::<String, String>("primary down".into()) };
        let fallback = async { Err::<String, String>("fallback rate limited".into()) };
        let errors = run_hedged(Duration::from_millis(5), primary, Some(fallback), |_| true)
            .await
            .unwrap_err();
        assert_eq!(errors.0.as_deref(), Some("primary down"));
        assert_eq!(errors.1.as_deref(), Some("fallback rate limited"));
    }

    #[test]
    fn rejects_tone_substitution_and_invented_causality() {
        assert!(!is_plausible("Hey, quick one.", "Yo, quick one."));
        assert!(is_plausible("Yo, quick one.", "Yo, quick one."));
        assert!(!is_plausible(
            "The onboarding copy needs a pass because it's too wordy.",
            "The onboarding copy needs a pass. It's too wordy."
        ));
        assert!(is_plausible(
            "The onboarding copy needs a pass because it's too wordy.",
            "the copy needs a pass because it's too wordy"
        ));
    }

    #[test]
    fn rejects_click_one_becoming_qwen() {
        assert!(!is_plausible(
            "Hey Qwen, the deploy broke again.",
            "Hey, ClickOne, the deploy broke again."
        ));
        assert!(is_plausible(
            "We tested Qwen against Gemma.",
            "We tested Quen against Gemma."
        ));
    }

    #[test]
    fn rejects_an_invented_speaker() {
        assert!(!is_plausible(
            "Gough replied: thanks for the update.",
            "Goff reply: thanks for the update."
        ));
        assert!(is_plausible(
            "Sarah said thanks.",
            "sarah said thanks"
        ));
    }

    #[test]
    fn rejects_an_invented_meridiem() {
        assert!(!is_plausible(
            "Book the room for Thursday at 3:30 p.m.",
            "Book the room for Thursday at 3:30."
        ));
        assert!(is_plausible(
            "Call at 3:30 p.m.",
            "call at 3:30 pm"
        ));
        assert!(is_plausible(
            "Call at 3:30 p.m.",
            "call at 3:30 in the afternoon"
        ));
        // "I am" must not count as a clock marker.
        assert!(!is_plausible(
            "I am out on Friday at 3 p.m.",
            "I am out on Friday at 3"
        ));
    }

    #[test]
    fn rejects_expanding_casual_forms() {
        assert!(!is_plausible("I want to ship it.", "I wanna ship it."));
        assert!(is_plausible("I wanna ship it.", "I wanna ship it."));
        assert!(!is_plausible("Yes, that works.", "yeah, that works"));
    }

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
    fn markdown_title_is_not_sent_to_the_model() {
        let prompt = build_system_prompt(
            "# Ray dictation cleanup — system prompt v4\n\nYou are the cleanup stage.",
            &[],
            &[],
            "Notepad",
        );
        assert_eq!(prompt, "You are the cleanup stage.");
        assert!(!prompt.contains("system prompt v4"));
    }

    #[test]
    fn empty_dictionary_and_names_render_cleanly() {
        let prompt = build_system_prompt(
            "Words: {{DICTIONARY}}. Names: {{KNOWN_NAMES}}.",
            &[],
            &[],
            "Unknown app",
        );
        assert_eq!(prompt, "Words: (none). Names: (none).");
        assert!(!prompt.contains('\u{2014}'));
    }

    #[test]
    fn transcript_sanitises_replacement_and_control_characters() {
        assert_eq!(
            sanitize_transcript("Let's do Tuesday\u{FFFD} no,   actually Wednesday.\u{0007}"),
            "Let's do Tuesday, no, actually Wednesday."
        );
        assert_eq!(sanitize_transcript("  Hello\n\tthere.  "), "Hello there.");
    }

    #[test]
    fn model_output_never_contains_replacement_characters() {
        assert_eq!(
            sanitize("Our budget is tight\u{FFFD}we want 1.5 s."),
            "Our budget is tight, we want 1.5 s."
        );
        assert_eq!(
            sanitize("Let's do Tuesday\u{FFFD} no, Wednesday."),
            "Let's do Tuesday, no, Wednesday."
        );
        assert_eq!(sanitize("\u{FFFD}Hello."), "Hello.");
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
        assert!(!is_plausible(
            "The capital of France is Paris. It has been the country's capital since 987, and it is also the largest city in France, with a population of about 2.1 million people.",
            "what is the capital of france"
        ));
    }

    #[test]
    fn accepts_a_heavily_disfluent_transcript_that_cleans_up_short() {
        let transcript = "um, so, I mean, like, you know, I was thinking, like, we should, um, \
            probably, you know, move the meeting to Thursday, no, actually Friday, because, um, \
            a couple of people are out, so, yeah, maybe Friday, sorry, Friday works better, \
            I think, um, let's do Friday at 3, no, 3:30";
        let cleaned = "Let's move the meeting to Friday at 3:30 because a couple of people are out.";
        assert!(transcript.chars().count() > 200);
        assert!(cleaned.chars().count() * 4 > transcript.chars().count());
        assert!(is_plausible(cleaned, transcript));
    }
}
