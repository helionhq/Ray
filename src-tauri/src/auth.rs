//! Desktop sign-in and account state.
//!
//! Sign-in happens in the system browser (Google blocks OAuth in embedded
//! webviews). The desktops opens `{SITE_URL}/desktop/sign-in` with a PKCE-style
//! state/challenge pair, receives `ray://auth/callback?code=…&state=…` through
//! the deep-link plugin, verifies the state, exchanges the code for a device
//! token, and stores that token in Windows Credential Manager (service `ray`,
//! account `session`). Every API request then sends
//! `Authorization: Bearer <device token>`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::api::{self, ApiError, ApiErrorKind};
use crate::pipeline::Dictation;
use crate::secrets;

/// How long a browser sign-in may take before its state is stale.
const PENDING_TTL: Duration = Duration::from_secs(5 * 60);

const URL_SAFE_NO_PAD: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AccountUser {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Usage {
    pub words_used: u64,
    /// `null` for Pro: the fair-use cap is never exposed.
    pub words_limit: Option<u64>,
    pub week_start: Option<String>,
    pub resets_at: Option<String>,
}

/// The `/api/me` response.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Account {
    pub user: AccountUser,
    /// "starter" or "pro".
    pub plan: String,
    pub interval: Option<String>,
    pub status: Option<String>,
    pub cancel_at_period_end: bool,
    pub current_period_end: Option<String>,
    pub usage: Usage,
}

impl Account {
    /// True when a Starter account has no words left this week. Pro's limit is
    /// deliberately absent, so this never blocks a Pro account.
    pub fn starter_is_over_limit(&self) -> bool {
        self.plan.eq_ignore_ascii_case("starter")
            && self
                .usage
                .words_limit
                .is_some_and(|limit| self.usage.words_used >= limit)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AuthState {
    pub signed_in: bool,
    pub account: Option<Account>,
}

struct Pending {
    state: String,
    verifier: String,
    created: Instant,
}

pub struct Auth {
    token: Mutex<Option<String>>,
    account: Mutex<Option<Account>>,
    pending: Mutex<Option<Pending>>,
    /// Bumped on cancel/sign-out so an in-flight callback cannot resurrect a
    /// session the user abandoned.
    generation: AtomicU64,
}

impl Auth {
    pub fn load() -> Self {
        Self {
            token: Mutex::new(secrets::device_token()),
            account: Mutex::new(None),
            pending: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }

    pub fn is_signed_in(&self) -> bool {
        self.token().is_some()
    }

    pub fn token(&self) -> Option<String> {
        self.token
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn account(&self) -> Option<Account> {
        self.account
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn state(&self) -> AuthState {
        AuthState {
            signed_in: self.is_signed_in(),
            account: self.account(),
        }
    }

    /// Start a browser sign-in. The returned URL is safe to open externally.
    pub fn begin_sign_in(&self, api_base: &str) -> Result<String, String> {
        let state = random_token(32);
        let verifier = random_token(32);
        let challenge = challenge_for(&verifier);
        let sign_in_url = api::endpoint(api_base, "/desktop/sign-in");
        let mut url = Url::parse(&sign_in_url)
            .map_err(|error| format!("Invalid Ray sign-in URL: {error}"))?;
        url.query_pairs_mut()
            .append_pair("state", &state)
            .append_pair("challenge", &challenge);
        *self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(Pending {
            state,
            verifier,
            created: Instant::now(),
        });
        Ok(url.to_string())
    }

    pub fn cancel_sign_in(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        *self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }

    /// Validate a callback's `state` and consume the verifier. A mismatched
    /// state does not clear the pending attempt: a stale or forged link must
    /// not cancel a legitimate sign-in the user still has open.
    fn take_callback_verifier(&self, state: &str) -> Option<String> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let matches = pending.as_ref().is_some_and(|pending| {
            pending.created.elapsed() <= PENDING_TTL && constant_time_eq(&pending.state, state)
        });
        if !matches {
            return None;
        }
        pending.take().map(|pending| pending.verifier)
    }

    pub fn complete_sign_in(&self, token: String) -> Result<(), String> {
        if token.trim().is_empty() {
            return Err("Ray returned an empty session token".into());
        }
        secrets::save_device_token(&token)?;
        *self.token.lock().unwrap_or_else(|error| error.into_inner()) = Some(token);
        *self
            .account
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        Ok(())
    }

    pub fn set_account(&self, account: Account) {
        *self
            .account
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(account);
    }

    /// Clear the local session. Used by sign-out and by a 401 from any API.
    pub fn sign_out_local(&self) {
        self.cancel_sign_in();
        *self.token.lock().unwrap_or_else(|error| error.into_inner()) = None;
        *self
            .account
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        if let Err(error) = secrets::clear_device_token() {
            eprintln!("[ray] could not clear the Ray session: {error}");
        }
    }

    /// The bar/pipeline check before recording starts.
    pub fn block_reason(&self) -> Option<&'static str> {
        if !self.is_signed_in() {
            return Some("Sign in to Ray to dictate");
        }
        if self
            .account()
            .is_some_and(|account| account.starter_is_over_limit())
        {
            return Some("Weekly limit reached");
        }
        None
    }
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    difference == 0
}

pub fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

/// `base64url(sha256(verifier))`, unpadded.
pub fn challenge_for(verifier: &str) -> String {
    let digest = sha2::Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

#[derive(Debug, PartialEq, Eq)]
pub enum DeepLinkEvent {
    AuthCallback { code: String, state: String },
    BillingSuccess,
}

/// Parse one `ray://` URL. Both `ray://auth/callback?...` (host form) and
/// `ray:///auth/callback?...` (path form) are accepted. Anything else, including
/// a spoofed path, is ignored.
pub fn parse_deep_link(raw: &str) -> Option<DeepLinkEvent> {
    let url = Url::parse(raw.trim()).ok()?;
    if !url.scheme().eq_ignore_ascii_case("ray") {
        return None;
    }
    let host = url.host_str().unwrap_or("").trim_matches('/');
    let path = url.path().trim_matches('/');
    let route = if host.is_empty() {
        path.to_string()
    } else if path.is_empty() {
        host.to_string()
    } else {
        format!("{host}/{path}")
    };
    match route.as_str() {
        "auth/callback" => {
            let mut code = None;
            let mut state = None;
            for (key, value) in url.query_pairs() {
                match key.as_ref() {
                    "code" if !value.is_empty() => code = Some(value.into_owned()),
                    "state" if !value.is_empty() => state = Some(value.into_owned()),
                    _ => {}
                }
            }
            Some(DeepLinkEvent::AuthCallback {
                code: code?,
                state: state?,
            })
        }
        "billing/success" => Some(DeepLinkEvent::BillingSuccess),
        _ => None,
    }
}

pub enum DeepLinkOutcome {
    Ignored,
    /// Boxed: `AuthState` is much larger than the ignored variant, and the
    /// event path hands it straight to the emitter.
    Changed(Box<AuthState>),
}

/// Handle a deep link on the Rust side. `Ok(Ignored)` means the URL was not a
/// Ray auth/billing route.
pub async fn handle_deep_link(
    auth: &Auth,
    http: &reqwest::Client,
    api_base: &str,
    raw: &str,
) -> Result<DeepLinkOutcome, String> {
    match parse_deep_link(raw) {
        None => Ok(DeepLinkOutcome::Ignored),
        Some(DeepLinkEvent::AuthCallback { code, state }) => {
            let generation = auth.generation.load(Ordering::SeqCst);
            let Some(verifier) = auth.take_callback_verifier(&state) else {
                return Err(
                    "This sign-in link is invalid or has expired. Try signing in again.".into(),
                );
            };
            let token = exchange_code(http, api_base, &code, &verifier)
                .await
                .map_err(|error| error.to_string())?;
            // Cancel (or sign-out) raced the exchange: do not resurrect the
            // session the user abandoned.
            if auth.generation.load(Ordering::SeqCst) != generation {
                return Err("Sign-in was cancelled.".into());
            }
            auth.complete_sign_in(token)?;
            match fetch_me(http, api_base, &auth.token().unwrap_or_default()).await {
                Ok(account) => auth.set_account(account),
                Err(error) if error.kind == ApiErrorKind::Unauthorized => {
                    auth.sign_out_local();
                    return Err(error.to_string());
                }
                // Signed in, but the account summary can be fetched later.
                Err(error) => eprintln!("[ray] could not load the account after sign-in: {error}"),
            }
            Ok(DeepLinkOutcome::Changed(Box::new(auth.state())))
        }
        Some(DeepLinkEvent::BillingSuccess) => {
            if !auth.is_signed_in() {
                return Ok(DeepLinkOutcome::Ignored);
            }
            match refresh(auth, http, api_base).await {
                Ok(state) => Ok(DeepLinkOutcome::Changed(Box::new(state))),
                Err(error) => {
                    eprintln!("[ray] could not refresh the account after billing: {error}");
                    Ok(DeepLinkOutcome::Changed(Box::new(auth.state())))
                }
            }
        }
    }
}

pub async fn exchange_code(
    http: &reqwest::Client,
    api_base: &str,
    code: &str,
    verifier: &str,
) -> Result<String, ApiError> {
    let response = http
        .post(api::endpoint(api_base, "/api/desktop/token"))
        .json(&json!({ "code": code, "verifier": verifier }))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| ApiError::other(format!("Could not reach Ray: {error}")))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| {
        ApiError::other(format!("Could not read the sign-in response: {error}"))
    })?;
    if !status.is_success() {
        return Err(
            ApiError::from_response(status.as_u16(), &text).unwrap_or_else(|| {
                ApiError::other(format!(
                    "Ray rejected the sign-in (HTTP {status}): {}",
                    api::message_from_body(&text)
                ))
            }),
        );
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| ApiError::other(format!("Ray sent invalid JSON: {error}")))?;
    value
        .get("token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .ok_or_else(|| ApiError::other("Ray returned no session token"))
}

pub async fn fetch_me(
    http: &reqwest::Client,
    api_base: &str,
    token: &str,
) -> Result<Account, ApiError> {
    let response = http
        .get(api::endpoint(api_base, "/api/me"))
        .header("authorization", api::authorization(token))
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|error| ApiError::other(format!("Could not reach Ray: {error}")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| ApiError::other(format!("Could not read the account: {error}")))?;
    if !status.is_success() {
        return Err(
            ApiError::from_response(status.as_u16(), &text).unwrap_or_else(|| {
                ApiError::other(format!(
                    "Could not load the account (HTTP {status}): {}",
                    api::message_from_body(&text)
                ))
            }),
        );
    }
    serde_json::from_str::<Account>(&text)
        .map_err(|error| ApiError::other(format!("Ray sent an invalid account: {error}")))
}

pub async fn refresh(
    auth: &Auth,
    http: &reqwest::Client,
    api_base: &str,
) -> Result<AuthState, ApiError> {
    let Some(token) = auth.token() else {
        return Ok(auth.state());
    };
    match fetch_me(http, api_base, &token).await {
        Ok(account) => {
            auth.set_account(account);
            Ok(auth.state())
        }
        Err(error) if error.kind == ApiErrorKind::Unauthorized => {
            auth.sign_out_local();
            Err(error)
        }
        Err(error) => Err(error),
    }
}

/// Revoke the device token server-side. Local cleanup always happens, even if
/// the network is down.
pub async fn signout(http: &reqwest::Client, api_base: &str, token: &str) {
    let _ = http
        .post(api::endpoint(api_base, "/api/desktop/signout"))
        .header("authorization", api::authorization(token))
        .timeout(Duration::from_secs(10))
        .send()
        .await;
}

async fn billing_url(
    http: &reqwest::Client,
    api_base: &str,
    token: &str,
    path: &str,
    body: Option<Value>,
) -> Result<String, ApiError> {
    let mut request = http
        .post(api::endpoint(api_base, path))
        .header("authorization", api::authorization(token))
        .timeout(Duration::from_secs(15));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| ApiError::other(format!("Could not reach Ray: {error}")))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| {
        ApiError::other(format!("Could not read the billing response: {error}"))
    })?;
    if !status.is_success() {
        return Err(
            ApiError::from_response(status.as_u16(), &text).unwrap_or_else(|| {
                ApiError::other(format!(
                    "Ray could not open billing (HTTP {status}): {}",
                    api::message_from_body(&text)
                ))
            }),
        );
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| ApiError::other(format!("Ray sent invalid JSON: {error}")))?;
    value
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ApiError::other("Ray returned no billing URL"))
}

/// Common handling for checkout and the portal: a 401 clears the local session.
fn billing_error(app: &AppHandle, auth: &Auth, error: ApiError) -> String {
    if error.kind == ApiErrorKind::Unauthorized {
        auth.sign_out_local();
        emit_account_changed(app, &auth.state());
    }
    error.to_string()
}

fn emit_account_changed(app: &AppHandle, state: &AuthState) {
    let _ = app.emit("account-changed", state.clone());
}

fn open_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("Could not open your browser: {error}"))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn auth_state(auth: State<'_, Arc<Auth>>) -> AuthState {
    auth.state()
}

/// Open the browser hand-off. The command returns as soon as the browser is
/// launched; the UI waits for `account-changed` (or the user cancels).
#[tauri::command]
pub async fn sign_in(
    app: AppHandle,
    auth: State<'_, Arc<Auth>>,
    dictation: State<'_, Arc<Dictation>>,
) -> Result<(), String> {
    let url = auth.begin_sign_in(&dictation.api_base())?;
    if let Err(error) = open_browser(&app, &url) {
        auth.cancel_sign_in();
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_sign_in(auth: State<'_, Arc<Auth>>) {
    auth.cancel_sign_in();
}

#[tauri::command]
pub async fn sign_out(
    app: AppHandle,
    auth: State<'_, Arc<Auth>>,
    dictation: State<'_, Arc<Dictation>>,
) -> Result<AuthState, String> {
    if let Some(token) = auth.token() {
        signout(dictation.http(), &dictation.api_base(), &token).await;
    }
    auth.sign_out_local();
    let state = auth.state();
    emit_account_changed(&app, &state);
    Ok(state)
}

#[tauri::command]
pub async fn refresh_account(
    app: AppHandle,
    auth: State<'_, Arc<Auth>>,
    dictation: State<'_, Arc<Dictation>>,
) -> Result<AuthState, String> {
    let result = refresh(&auth, dictation.http(), &dictation.api_base()).await;
    let state = auth.state();
    emit_account_changed(&app, &state);
    match result {
        Ok(state) => Ok(state),
        Err(error) if error.kind == ApiErrorKind::Unauthorized => Ok(state),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn open_checkout(
    interval: String,
    app: AppHandle,
    auth: State<'_, Arc<Auth>>,
    dictation: State<'_, Arc<Dictation>>,
) -> Result<(), String> {
    let interval = interval.trim().to_ascii_lowercase();
    if interval != "monthly" && interval != "annual" {
        return Err(format!("Unknown billing interval: {interval}"));
    }
    let token = auth
        .token()
        .ok_or_else(|| "Sign in to Ray first.".to_string())?;
    let url = billing_url(
        dictation.http(),
        &dictation.api_base(),
        &token,
        "/api/billing/checkout",
        Some(json!({ "interval": interval })),
    )
    .await
    .map_err(|error| billing_error(&app, &auth, error))?;
    open_browser(&app, &url)
}

#[tauri::command]
pub async fn open_billing_portal(
    app: AppHandle,
    auth: State<'_, Arc<Auth>>,
    dictation: State<'_, Arc<Dictation>>,
) -> Result<(), String> {
    let token = auth
        .token()
        .ok_or_else(|| "Sign in to Ray first.".to_string())?;
    let url = billing_url(
        dictation.http(),
        &dictation.api_base(),
        &token,
        "/api/billing/portal",
        None,
    )
    .await
    .map_err(|error| billing_error(&app, &auth, error))?;
    open_browser(&app, &url)
}

/// Re-read the account and tell every window. Used by the pipeline after a
/// dictation and when `ray://billing/success` arrives.
pub fn refresh_shared(app: &AppHandle, auth: &Arc<Auth>, http: &reqwest::Client, api_base: &str) {
    let auth = auth.clone();
    let app = app.clone();
    let http = http.clone();
    let api_base = api_base.to_string();
    tauri::async_runtime::spawn(async move {
        match refresh(&auth, &http, &api_base).await {
            Ok(state) => emit_account_changed(&app, &state),
            Err(error) if error.kind == ApiErrorKind::Unauthorized => {
                emit_account_changed(&app, &auth.state());
            }
            Err(error) => eprintln!("[ray] could not refresh the account: {error}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_the_known_sha256_vector() {
        // SHA-256("abc") = ba7816bf...0015ad; base64url without padding.
        assert_eq!(
            challenge_for("abc"),
            "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"
        );
    }

    #[test]
    fn random_tokens_are_urlsafe_and_unique() {
        let first = random_token(32);
        let second = random_token(32);
        assert_ne!(first, second);
        // 32 bytes -> 43 unpadded base64url characters.
        assert_eq!(first.len(), 43);
        assert!(first
            .chars()
            .all(|character| character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'));
    }

    fn auth_with_pending() -> Auth {
        let auth = Auth {
            token: Mutex::new(None),
            account: Mutex::new(None),
            pending: Mutex::new(None),
            generation: AtomicU64::new(0),
        };
        auth.begin_sign_in("https://ray.example").expect("url");
        auth
    }

    #[test]
    fn state_check_accepts_only_the_pending_state() {
        let auth = auth_with_pending();
        let state = auth
            .pending
            .lock()
            .unwrap()
            .as_ref()
            .map(|pending| pending.state.clone())
            .unwrap();

        // A forged/stale state is rejected but must not cancel the attempt.
        assert_eq!(auth.take_callback_verifier("not-the-state"), None);
        assert!(auth.pending.lock().unwrap().is_some());

        // The real state consumes the verifier exactly once.
        assert!(auth.take_callback_verifier(&state).is_some());
        assert!(auth.take_callback_verifier(&state).is_none());
    }

    #[test]
    fn an_expired_pending_sign_in_is_rejected() {
        let auth = auth_with_pending();
        let state = {
            let mut pending = auth.pending.lock().unwrap();
            let pending = pending.as_mut().unwrap();
            pending.created = Instant::now() - PENDING_TTL - Duration::from_secs(1);
            pending.state.clone()
        };
        assert_eq!(auth.take_callback_verifier(&state), None);
    }

    #[test]
    fn cancel_invalidates_the_pending_attempt() {
        let auth = auth_with_pending();
        let state = {
            let pending = auth.pending.lock().unwrap();
            pending.as_ref().unwrap().state.clone()
        };
        auth.cancel_sign_in();
        assert_eq!(auth.take_callback_verifier(&state), None);
    }

    #[test]
    fn deep_link_parsing_accepts_auth_and_billing_routes() {
        assert_eq!(
            parse_deep_link("ray://auth/callback?code=abc&state=xyz"),
            Some(DeepLinkEvent::AuthCallback {
                code: "abc".into(),
                state: "xyz".into()
            })
        );
        assert_eq!(
            parse_deep_link("ray:///auth/callback?code=abc&state=xyz"),
            Some(DeepLinkEvent::AuthCallback {
                code: "abc".into(),
                state: "xyz".into()
            })
        );
        assert_eq!(
            parse_deep_link("ray://billing/success"),
            Some(DeepLinkEvent::BillingSuccess)
        );
        assert_eq!(
            parse_deep_link("ray://billing/success/"),
            Some(DeepLinkEvent::BillingSuccess)
        );
    }

    #[test]
    fn deep_link_parsing_rejects_malformed_or_foreign_urls() {
        assert_eq!(
            parse_deep_link("https://ray.helionhq.com/auth/callback?code=a&state=b"),
            None
        );
        assert_eq!(parse_deep_link("ray://auth/callback?state=xyz"), None);
        assert_eq!(parse_deep_link("ray://auth/callback?code=abc"), None);
        assert_eq!(parse_deep_link("ray://auth/elsewhere?code=a&state=b"), None);
        assert_eq!(parse_deep_link("not a url"), None);
        assert_eq!(parse_deep_link(""), None);
    }

    #[test]
    fn sign_in_url_carries_state_and_challenge() {
        let auth = Auth {
            token: Mutex::new(None),
            account: Mutex::new(None),
            pending: Mutex::new(None),
            generation: AtomicU64::new(0),
        };
        let raw = auth
            .begin_sign_in("https://ray.helionhq.com")
            .expect("sign-in url");
        let url = Url::parse(&raw).unwrap();
        assert_eq!(url.path(), "/desktop/sign-in");
        let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        let state = params.get("state").expect("state");
        let challenge = params.get("challenge").expect("challenge");
        let verifier = auth
            .pending
            .lock()
            .unwrap()
            .as_ref()
            .map(|pending| pending.verifier.clone())
            .unwrap();
        assert_eq!(challenge_for(&verifier), *challenge);
        assert_ne!(state, challenge);
    }

    #[test]
    fn only_starter_at_or_over_its_limit_is_blocked() {
        let mut account = Account {
            plan: "starter".into(),
            usage: Usage {
                words_used: 999,
                words_limit: Some(1_000),
                ..Usage::default()
            },
            ..Account::default()
        };
        assert!(!account.starter_is_over_limit());
        account.usage.words_used = 1_000;
        assert!(account.starter_is_over_limit());
        account.usage.words_used = 1_042;
        assert!(account.starter_is_over_limit());

        let pro = Account {
            plan: "pro".into(),
            usage: Usage {
                words_used: 500_000,
                words_limit: None,
                ..Usage::default()
            },
            ..Account::default()
        };
        assert!(!pro.starter_is_over_limit());
        // A missing plan must not lock the user out.
        assert!(!Account::default().starter_is_over_limit());
    }

    #[test]
    fn auth_state_serializes_for_the_webview() {
        let state = AuthState {
            signed_in: true,
            account: Some(Account {
                user: AccountUser {
                    id: "user_1".into(),
                    email: "a@b.com".into(),
                    name: Some("Arham".into()),
                },
                plan: "starter".into(),
                usage: Usage {
                    words_used: 412,
                    words_limit: Some(1_000),
                    week_start: Some("2026-11-02T00:00:00Z".into()),
                    resets_at: Some("2026-11-09T00:00:00Z".into()),
                },
                ..Account::default()
            }),
        };
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value["signed_in"], true);
        assert_eq!(value["account"]["user"]["email"], "a@b.com");
        assert_eq!(value["account"]["usage"]["words_limit"], 1_000);
    }

    #[test]
    fn block_reason_requires_a_session_before_a_quota() {
        let auth = Auth {
            token: Mutex::new(None),
            account: Mutex::new(Some(Account {
                plan: "starter".into(),
                usage: Usage {
                    words_used: 1_000,
                    words_limit: Some(1_000),
                    ..Usage::default()
                },
                ..Account::default()
            })),
            pending: Mutex::new(None),
            generation: AtomicU64::new(0),
        };
        assert_eq!(auth.block_reason(), Some("Sign in to Ray to dictate"));
        *auth.token.lock().unwrap() = Some("ray_test".into());
        assert_eq!(auth.block_reason(), Some("Weekly limit reached"));
    }
}
