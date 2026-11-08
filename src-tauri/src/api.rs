//! Shared plumbing for the Ray API.
//!
//! Every network request now goes to the same origin (`api.base_url`), using
//! the device token stored by `auth`. The quota and auth responses are the only
//! statuses that must never be retried or handled by a fallback path, so they
//! are classified once here and carried as a typed error through STT and
//! cleanup.

use serde_json::Value;

/// Why a Ray API request failed. Only the first three variants are fatal to a
/// dictation session; `Other` keeps the existing retry/fallback behavior.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiErrorKind {
    Unauthorized,
    QuotaExceeded,
    FairUse,
    Other,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ApiError {
    pub kind: ApiErrorKind,
    pub status: Option<u16>,
    /// Human-readable text from the API, or the technical description for an
    /// `Other` error. Kept as a boxed string so `Result<T, ApiError>` stays
    /// small enough to pass through the pipeline without boxing every result.
    pub message: Option<String>,
    pub resets_at: Option<String>,
}

impl ApiError {
    pub fn other(message: impl Into<String>) -> Self {
        Self {
            kind: ApiErrorKind::Other,
            status: None,
            message: Some(message.into()),
            resets_at: None,
        }
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            kind: ApiErrorKind::Unauthorized,
            status: Some(401),
            message: Some(message.into()),
            resets_at: None,
        }
    }

    /// Classify a quota/auth response. Any other status returns `None` so the
    /// caller keeps its normal retry or fallback logic.
    pub fn from_response(status: u16, body: &str) -> Option<Self> {
        let kind = match status {
            401 => ApiErrorKind::Unauthorized,
            402 => ApiErrorKind::QuotaExceeded,
            429 => ApiErrorKind::FairUse,
            _ => return None,
        };
        let value = serde_json::from_str::<Value>(body).ok();
        let field = |name: &str| {
            value
                .as_ref()
                .and_then(|value| value.get(name))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let message = field("message").unwrap_or_else(|| match kind {
            ApiErrorKind::Unauthorized => "Your session expired. Sign in to Ray again.".into(),
            ApiErrorKind::QuotaExceeded => "Weekly limit reached".into(),
            ApiErrorKind::FairUse => "Fair-use limit reached, resets Monday".into(),
            ApiErrorKind::Other => String::new(),
        });
        Some(Self {
            kind,
            status: Some(status),
            message: Some(message),
            resets_at: field("resets_at"),
        })
    }

    /// True when the session must stop immediately: no batch fallback, no
    /// cleanup retry, no paste.
    pub fn is_fatal(&self) -> bool {
        self.kind != ApiErrorKind::Other
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.message.as_deref() {
            Some(message) if !message.is_empty() => formatter.write_str(message),
            _ => formatter.write_str("Ray request failed"),
        }
    }
}

impl std::error::Error for ApiError {}

/// `{base}/path` without a doubled slash, regardless of how the origin was
/// written in config or an override.
pub fn endpoint(base: &str, path: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let path = path.trim_start_matches('/');
    format!("{base}/{path}")
}

pub fn authorization(token: &str) -> String {
    format!("Bearer {}", token.trim())
}

/// The most useful human string from an error body: the Ray API's
/// `{"error": "...", "message": "..."}` shape, then a bare `message`, then a
/// trimmed prefix of the body for non-JSON upstream responses.
pub fn message_from_body(body: &str) -> String {
    let trimmed = body.trim();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_and_auth_responses_are_typed() {
        let quota = ApiError::from_response(
            402,
            r#"{"error":"quota_exceeded","message":"You have used all 1,000 words.","plan":"starter","words_used":1000,"words_limit":1000,"resets_at":"2026-11-09T00:00:00Z"}"#,
        )
        .expect("402 is typed");
        assert_eq!(quota.kind, ApiErrorKind::QuotaExceeded);
        assert_eq!(
            quota.message.as_deref(),
            Some("You have used all 1,000 words.")
        );
        assert_eq!(quota.resets_at.as_deref(), Some("2026-11-09T00:00:00Z"));
        assert!(quota.is_fatal());

        let fair_use = ApiError::from_response(
            429,
            r#"{"error":"fair_use","message":"Fair-use limit reached.","resets_at":"2026-11-09T00:00:00Z"}"#,
        )
        .expect("429 is typed");
        assert_eq!(fair_use.kind, ApiErrorKind::FairUse);
        assert_eq!(fair_use.resets_at.as_deref(), Some("2026-11-09T00:00:00Z"));
        assert!(fair_use.is_fatal());

        let unauthorized =
            ApiError::from_response(401, r#"{"error":"unauthorized"}"#).expect("401 is typed");
        assert_eq!(unauthorized.kind, ApiErrorKind::Unauthorized);
        assert!(unauthorized.is_fatal());
    }

    #[test]
    fn other_statuses_keep_the_fallback_path() {
        for status in [400, 403, 404, 408, 500, 502, 503, 504] {
            assert!(
                ApiError::from_response(status, "{}").is_none(),
                "{status} must not be fatal"
            );
        }
        assert!(!ApiError::other("network down").is_fatal());
    }

    #[test]
    fn typed_errors_default_to_readable_messages() {
        let quota = ApiError::from_response(402, "").unwrap();
        assert_eq!(quota.to_string(), "Weekly limit reached");
        let fair = ApiError::from_response(429, "not json").unwrap();
        assert!(fair.to_string().contains("Fair-use"));
        let auth = ApiError::from_response(401, "").unwrap();
        assert!(auth.to_string().contains("Sign in"));
    }

    #[test]
    fn endpoints_join_without_doubled_slashes() {
        assert_eq!(
            endpoint("https://ray.helionhq.com", "/v1/stt/sync"),
            "https://ray.helionhq.com/v1/stt/sync"
        );
        assert_eq!(
            endpoint("https://ray.helionhq.com/", "v1/stt/sync"),
            "https://ray.helionhq.com/v1/stt/sync"
        );
        assert_eq!(
            endpoint("http://127.0.0.1:8787", "/v1/ping"),
            "http://127.0.0.1:8787/v1/ping"
        );
    }

    #[test]
    fn error_bodies_are_reduced_to_a_message() {
        assert_eq!(
            message_from_body(r#"{"error":{"message":"upstream broke"}}"#),
            "upstream broke"
        );
        assert_eq!(message_from_body(r#"{"message":"try later"}"#), "try later");
        assert_eq!(message_from_body("  plain text  "), "plain text");
        assert_eq!(message_from_body(""), "");
    }
}
