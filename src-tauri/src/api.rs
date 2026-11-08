//! Shared plumbing for the Ray API.
//!
//! Every network request now goes to the same origin (`api.base_url`), using
//! the device token stored by `auth`. Ray errors are classified by their JSON
//! `error` code, never by status alone: upstream 401/402/403/429 responses are
//! mapped by the Worker to `502 upstream_error` / `503 upstream_busy`, so a
//! status can never be trusted to describe the account state. Only
//! `unauthorized` signs out; only `quota_exceeded` / `fair_use` / `device_limit`
//! skip the batch fallback.

use serde_json::Value;

/// Why a Ray API request failed. Only the first four variants are fatal to a
/// dictation session; `Other` keeps the existing retry/fallback behavior.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiErrorKind {
    Unauthorized,
    QuotaExceeded,
    FairUse,
    /// This account has used up its PC's free accounts; only a paid plan can
    /// dictate.
    DeviceLimit,
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
    /// The JSON `error` code when the body carried one, including non-fatal
    /// codes (`already_subscribed`, `billing_issue`, `upstream_error`, …) that
    /// callers such as billing need to distinguish.
    pub code: Option<String>,
}

impl ApiError {
    pub fn other(message: impl Into<String>) -> Self {
        Self {
            kind: ApiErrorKind::Other,
            status: None,
            message: Some(message.into()),
            resets_at: None,
            code: None,
        }
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            kind: ApiErrorKind::Unauthorized,
            status: Some(401),
            message: Some(message.into()),
            resets_at: None,
            code: Some("unauthorized".into()),
        }
    }

    /// Classify a fatal Ray error strictly by its JSON `error` code. A status
    /// alone is not enough: the Worker maps upstream failures to
    /// `502 upstream_error` / `503 upstream_busy`, and a 401 without the
    /// `unauthorized` code is an upstream or proxy failure, not a dead session.
    /// Any other response returns `None` so the caller keeps its normal retry
    /// or fallback logic.
    pub fn from_response(status: u16, body: &str) -> Option<Self> {
        let code = error_code(body)?;
        let kind = match code.as_str() {
            "unauthorized" => ApiErrorKind::Unauthorized,
            "quota_exceeded" => ApiErrorKind::QuotaExceeded,
            "fair_use" => ApiErrorKind::FairUse,
            "device_limit" => ApiErrorKind::DeviceLimit,
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
            ApiErrorKind::DeviceLimit => "Free limit reached on this account".into(),
            ApiErrorKind::Other => String::new(),
        });
        Some(Self {
            kind,
            status: Some(status),
            message: Some(message),
            resets_at: field("resets_at"),
            code: Some(code),
        })
    }

    /// Build a non-fatal error for an HTTP response, retaining its JSON code
    /// so billing can react to `already_subscribed` / `billing_issue`. When
    /// the body carries a human `message`, that is shown as-is (no technical
    /// "HTTP 429:" prefix in the billing UI); otherwise the status is kept for
    /// debugging.
    pub fn from_http(status: u16, body: &str) -> Self {
        if let Some(mut error) = Self::from_response(status, body) {
            // Fatal Ray codes are already the most useful error.
            if error.status.is_none() {
                error.status = Some(status);
            }
            return error;
        }
        let message = json_message(body)
            .unwrap_or_else(|| format!("HTTP {status}: {}", message_from_body(body)));
        Self {
            kind: ApiErrorKind::Other,
            status: Some(status),
            message: Some(message),
            resets_at: None,
            code: error_code(body),
        }
    }

    /// True when the session must stop immediately: no batch fallback, no
    /// cleanup retry.
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

/// The JSON `error` code from a Ray error body, if the body has one.
pub fn error_code(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The human `message` from a JSON error body, if it has one.
fn json_message(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body.trim()).ok()?;
    let message = value
        .get("error")
        .and_then(|error| error.get("message").and_then(Value::as_str))
        .or_else(|| value.get("message").and_then(Value::as_str))?;
    (!message.trim().is_empty()).then(|| message.to_string())
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
                .and_then(|error| error.get("message").and_then(Value::as_str))
                .or_else(|| value.get("message").and_then(Value::as_str))
                .or_else(|| value.get("error").and_then(Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_else(|| trimmed.chars().take(300).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_and_auth_responses_are_typed_by_error_code() {
        let quota = ApiError::from_response(
            402,
            r#"{"error":"quota_exceeded","message":"You have used all 1,000 words.","plan":"starter","words_used":1000,"words_limit":1000,"resets_at":"2026-11-09T00:00:00Z"}"#,
        )
        .expect("402 with quota_exceeded is typed");
        assert_eq!(quota.kind, ApiErrorKind::QuotaExceeded);
        assert_eq!(
            quota.message.as_deref(),
            Some("You have used all 1,000 words.")
        );
        assert_eq!(quota.resets_at.as_deref(), Some("2026-11-09T00:00:00Z"));
        assert_eq!(quota.code.as_deref(), Some("quota_exceeded"));
        assert!(quota.is_fatal());

        let fair_use = ApiError::from_response(
            429,
            r#"{"error":"fair_use","message":"Fair-use limit reached.","resets_at":"2026-11-09T00:00:00Z"}"#,
        )
        .expect("429 with fair_use is typed");
        assert_eq!(fair_use.kind, ApiErrorKind::FairUse);
        assert_eq!(fair_use.resets_at.as_deref(), Some("2026-11-09T00:00:00Z"));
        assert!(fair_use.is_fatal());

        let device_limit = ApiError::from_response(
            402,
            r#"{"error":"device_limit","message":"This account can't use the free plan because too many accounts were created on one PC. Upgrade to Pro to keep dictating."}"#,
        )
        .expect("402 with device_limit is typed");
        assert_eq!(device_limit.kind, ApiErrorKind::DeviceLimit);
        assert_eq!(
            device_limit.message.as_deref(),
            Some(
                "This account can't use the free plan because too many accounts were created on one PC. Upgrade to Pro to keep dictating."
            )
        );
        assert!(device_limit.is_fatal());

        let device_limit_default = ApiError::from_response(402, r#"{"error":"device_limit"}"#)
            .expect("a bare device_limit is typed");
        assert_eq!(
            device_limit_default.to_string(),
            "Free limit reached on this account"
        );

        let unauthorized =
            ApiError::from_response(401, r#"{"error":"unauthorized"}"#).expect("401 is typed");
        assert_eq!(unauthorized.kind, ApiErrorKind::Unauthorized);
        assert!(unauthorized.is_fatal());
    }

    #[test]
    fn upstream_errors_never_look_like_ray_errors() {
        // The Worker maps an upstream 401/402/403/429/5xx to these codes; the
        // status may still be a misleading upstream-like one.
        for (status, code) in [
            (502, "upstream_error"),
            (503, "upstream_busy"),
            (429, "too_many_requests"),
            (403, "no_cleanup_grant"),
            (402, "billing_issue"),
            (409, "already_subscribed"),
        ] {
            let body = format!(r#"{{"error":"{code}","message":"try later"}}"#);
            assert!(
                ApiError::from_response(status, &body).is_none(),
                "{code} ({status}) must follow the normal fallback path"
            );
        }
        // An AssemblyAI-ish upstream failure body must not be retyped as a
        // Ray quota or auth error even when its status is 401/402/429.
        for status in [401, 402, 403, 429, 500, 502, 503] {
            let body = r#"{"error":"upstream_error","message":"The upstream API key is invalid","upstream_status":401}"#;
            let error = ApiError::from_http(status, body);
            assert_eq!(error.kind, ApiErrorKind::Other, "status {status}");
            assert!(!error.is_fatal());
            assert_eq!(error.code.as_deref(), Some("upstream_error"));
        }
    }

    #[test]
    fn a_401_without_the_unauthorized_code_does_not_sign_out() {
        // A bare or upstream-flavoured 401 must never clear the local session.
        for body in [
            "{}",
            "",
            "not json",
            r#"{"error":"upstream_error","message":"unauthorized upstream key"}"#,
            r#"{"error":"session_revoked"}"#,
        ] {
            assert!(
                ApiError::from_response(401, body).is_none(),
                "401 body {body:?} must not be treated as Ray unauthorized"
            );
        }
        assert!(!ApiError::from_http(401, "{}").is_fatal());
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
    fn rate_limits_are_not_fatal_and_keep_a_sensible_message() {
        // The Worker's rate-limit middleware, STT lease and failure budget all
        // send `429 too_many_requests`. The desktop must not treat it as a
        // quota/auth failure, and billing/authorize callers surface the
        // server's message.
        let error = ApiError::from_http(
            429,
            r#"{"error":"too_many_requests","message":"Too many requests. Try again in a moment."}"#,
        );
        assert_eq!(error.kind, ApiErrorKind::Other);
        assert!(!error.is_fatal());
        assert_eq!(error.code.as_deref(), Some("too_many_requests"));
        assert_eq!(
            error.to_string(),
            "Too many requests. Try again in a moment."
        );
    }

    #[test]
    fn typed_errors_default_to_readable_messages() {
        let quota = ApiError::from_response(402, r#"{"error":"quota_exceeded"}"#).unwrap();
        assert_eq!(quota.to_string(), "Weekly limit reached");
        let fair = ApiError::from_response(429, r#"{"error":"fair_use"}"#).unwrap();
        assert!(fair.to_string().contains("Fair-use"));
        let auth = ApiError::from_response(401, r#"{"error":"unauthorized"}"#).unwrap();
        assert!(auth.to_string().contains("Sign in"));
    }

    #[test]
    fn billing_error_codes_are_preserved() {
        let already = ApiError::from_http(409, r#"{"error":"already_subscribed"}"#);
        assert_eq!(already.kind, ApiErrorKind::Other);
        assert_eq!(already.code.as_deref(), Some("already_subscribed"));
        assert_eq!(already.status, Some(409));

        let issue = ApiError::from_http(
            409,
            r#"{"error":"billing_issue","message":"Update your card"}"#,
        );
        assert_eq!(issue.code.as_deref(), Some("billing_issue"));
        assert!(issue.to_string().contains("Update your card"));
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
