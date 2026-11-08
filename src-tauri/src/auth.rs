//! Desktop sign-in and account state.
//!
//! Sign-in happens in the system browser (Google blocks OAuth in embedded
//! webviews). The desktops opens `{SITE_URL}/desktop/sign-in` with a PKCE-style
//! state/challenge pair, receives `ray://auth/callback?code=…&state=…` through
//! the deep-link plugin, verifies the state, exchanges the code for a device
//! token, and stores that token in Windows Credential Manager (service `ray`,
//! account `session`). Every API request then sends
//! `Authorization: Bearer <device token>`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use tauri::{AppHandle, Emitter, Manager, State};
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
    /// `None` when the server sends `null`. The Worker now sends an empty
    /// string when the email is unknown, but an old or partial response must
    /// never fail the whole account load.
    pub email: Option<String>,
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

/// The no-card trial, present only while it is active. `plan` is `"pro"` then,
/// but `interval`/`status` stay empty because there is no subscription.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Trial {
    pub ends_at: Option<String>,
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
    /// Set when a non-entitled subscription still exists and needs a payment
    /// method fix: "past_due", "unpaid", or "paused".
    pub billing_issue: Option<String>,
    /// The active no-card trial; null for paid subscriptions and Starter.
    pub trial: Option<Trial>,
    /// This PC is over the free-account limit and has no paid plan.
    pub free_blocked: bool,
    pub usage: Usage,
}

impl Account {
    /// True while the account is on the no-card trial.
    pub fn trial_active(&self) -> bool {
        self.trial.is_some()
    }

    /// True when a Starter account has no words left this week. Pro and trial
    /// accounts have no visible word limit, so this never blocks them.
    pub fn starter_is_over_limit(&self) -> bool {
        self.plan.eq_ignore_ascii_case("starter")
            && !self.trial_active()
            && self
                .usage
                .words_limit
                .is_some_and(|limit| self.usage.words_used >= limit)
    }

    /// True when the cached usage belongs to a week that has already reset.
    /// Cached `words_used` must never block a new week's first dictation
    /// (review decision 15).
    pub fn usage_is_stale(&self) -> bool {
        self.usage_is_stale_at(now_unix_seconds())
    }

    pub fn usage_is_stale_at(&self, now: u64) -> bool {
        self.usage
            .resets_at
            .as_deref()
            .and_then(parse_rfc3339_seconds)
            .is_some_and(|resets_at| now >= resets_at)
    }
}

/// Unix seconds for the current system clock.
pub fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Parse the ISO-8601 UTC timestamps the Worker returns (`2026-11-09T00:00:00Z`)
/// without pulling in a date-time dependency. Fractional seconds and explicit
/// `±HH:MM` offsets are accepted; anything else is treated as unknown.
pub fn parse_rfc3339_seconds(value: &str) -> Option<u64> {
    let value = value.trim();
    // Every accepted component is ASCII, so this also guarantees the byte
    // slices below fall on character boundaries.
    if value.len() < 20 || !value.is_ascii() {
        return None;
    }
    let bytes = value.as_bytes();
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        std::str::from_utf8(&bytes[range]).ok()?.parse::<i64>().ok()
    };
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year = number(0..4)?;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=60).contains(&second)
    {
        return None;
    }
    let mut rest = &value[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        rest = &fraction[digits..];
    }
    let offset_seconds = match rest {
        "Z" | "z" => 0i64,
        _ if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) => {
            let sign = if rest.starts_with('-') { -1 } else { 1 };
            let hours = rest[1..3].parse::<i64>().ok()?;
            let minutes = rest[4..6].parse::<i64>().ok()?;
            if rest.as_bytes()[3] != b':' || hours > 23 || minutes > 59 {
                return None;
            }
            sign * (hours * 3_600 + minutes * 60)
        }
        _ => return None,
    };
    // Days from 1970-01-01 (Howard Hinnant's civil-date algorithm).
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_seconds;
    u64::try_from(seconds).ok()
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AuthState {
    pub signed_in: bool,
    /// False until the stored token has been read off the startup thread. The
    /// UI shows its loading screen instead of a signed-out flash while false.
    pub loaded: bool,
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
    /// Set once the credential store has been read (on a background thread).
    loaded: AtomicBool,
    /// Written before a sign-out clears the credential. If Credential Manager
    /// deletion fails, the next launch still sees this marker and does not
    /// resurrect the token.
    signed_out_marker: Option<PathBuf>,
}

impl Auth {
    /// Build an auth state without touching the credential store. Call
    /// [`Auth::load_stored_token`] from a background thread, then emit
    /// `account-changed` so the UI leaves its loading state.
    pub fn new(signed_out_marker: Option<PathBuf>) -> Self {
        Self {
            token: Mutex::new(None),
            account: Mutex::new(None),
            pending: Mutex::new(None),
            generation: AtomicU64::new(0),
            loaded: AtomicBool::new(false),
            signed_out_marker,
        }
    }

    /// Read the stored device token, unless a durable signed-out marker says
    /// the previous sign-out could not finish. Blocking; call off the main
    /// thread.
    pub fn load_stored_token(&self) {
        let signed_out = self
            .signed_out_marker
            .as_ref()
            .is_some_and(|path| path.exists());
        if !signed_out {
            if let Some(token) = secrets::device_token() {
                *self.token.lock().unwrap_or_else(|error| error.into_inner()) = Some(token);
            }
        }
        self.loaded.store(true, Ordering::SeqCst);
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded.load(Ordering::SeqCst)
    }

    /// Wait briefly for the background credential read. Deep links (and the
    /// first hotkey press) can arrive before startup finishes; treating that
    /// moment as signed out would drop a `ray://billing/success` or refuse to
    /// record for a signed-in user.
    pub async fn wait_loaded(&self, timeout: Duration) {
        let started = Instant::now();
        while !self.is_loaded() && started.elapsed() < timeout {
            tokio::time::sleep(Duration::from_millis(20)).await;
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
            loaded: self.is_loaded(),
            account: self.account(),
        }
    }

    /// Start a browser sign-in. `site_url` is the public site origin (not the
    /// API origin; it may differ in production). The returned URL is safe to
    /// open externally.
    pub fn begin_sign_in(&self, site_url: &str) -> Result<String, String> {
        let state = random_token(32);
        let verifier = random_token(32);
        let challenge = challenge_for(&verifier);
        let sign_in_url = api::endpoint(site_url, "/desktop/sign-in");
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
        self.clear_signed_out_marker();
        self.loaded.store(true, Ordering::SeqCst);
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

    /// Clear the local session. Used by an explicit sign-out and by a 401 from
    /// a request made with the current token.
    pub fn sign_out_local(&self) {
        self.cancel_sign_in();
        // Persist the intent before touching Credential Manager: if the delete
        // fails, the marker still stops the next launch from signing back in.
        self.write_signed_out_marker();
        *self.token.lock().unwrap_or_else(|error| error.into_inner()) = None;
        *self
            .account
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        if let Err(error) = secrets::clear_device_token() {
            eprintln!("[ray] could not clear the Ray session: {error}");
        }
    }

    /// Clear the session only if `token` is still the current one. A slow 401
    /// from an old request must never sign out a session the user has since
    /// replaced by signing in again.
    pub fn sign_out_if_token(&self, token: &str) -> bool {
        let mut current = self.token.lock().unwrap_or_else(|error| error.into_inner());
        if current.as_deref() != Some(token) {
            return false;
        }
        self.cancel_sign_in();
        self.write_signed_out_marker();
        *current = None;
        drop(current);
        *self
            .account
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        if let Err(error) = secrets::clear_device_token() {
            eprintln!("[ray] could not clear the Ray session: {error}");
        }
        true
    }

    fn write_signed_out_marker(&self) {
        if let Some(path) = &self.signed_out_marker {
            if let Err(error) = std::fs::write(path, b"signed out\n") {
                eprintln!("[ray] could not persist the signed-out marker: {error}");
            }
        }
    }

    fn clear_signed_out_marker(&self) {
        if let Some(path) = &self.signed_out_marker {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => eprintln!("[ray] could not remove the signed-out marker: {error}"),
            }
        }
    }

    /// The cached bar/pipeline check. The pipeline uses
    /// `Dictation::block_reason_fresh`, which also handles a stale week; this
    /// remains as the synchronous primitive its tests exercise.
    #[cfg(test)]
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
    app: &AppHandle,
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
            // session the user abandoned, and revoke the token we will not
            // keep so it does not outlive the attempt.
            if auth.generation.load(Ordering::SeqCst) != generation {
                signout(http, api_base, &token).await;
                return Err("Sign-in was cancelled.".into());
            }
            if let Err(error) = auth.complete_sign_in(token.clone()) {
                // The token is valid but could not be stored; revoke it
                // rather than leaving an orphaned credential on the server.
                signout(http, api_base, &token).await;
                return Err(error);
            }
            match fetch_me(http, api_base, &auth.token().unwrap_or_default()).await {
                Ok(account) => auth.set_account(account),
                Err(error) if error.kind == ApiErrorKind::Unauthorized => {
                    auth.sign_out_if_token(&token);
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
            // Creem's webhook can land a moment after the browser redirect, so
            // poll instead of trusting one immediate `/api/me`.
            Ok(DeepLinkOutcome::Changed(Box::new(
                poll_for_pro(app, auth, http, api_base).await,
            )))
        }
    }
}

/// Decision 16: poll `/api/me` at 1 s, 2 s, 4 s, … for ~45 s after billing,
/// stopping as soon as the plan is Pro. `billing-activating` tells the Account
/// page to show "Activating Pro…" for the duration.
async fn poll_for_pro(
    app: &AppHandle,
    auth: &Auth,
    http: &reqwest::Client,
    api_base: &str,
) -> AuthState {
    const DELAYS_MS: [u64; 6] = [1_000, 2_000, 4_000, 8_000, 16_000, 14_000];
    let Some(token) = auth.token() else {
        return auth.state();
    };
    emit_billing_activating(app, true);
    // Make the "Activating Pro…" state visible even if the user was on
    // another page (or the window was in the tray) when the browser bounced
    // back.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = app.emit_to("main", "navigate", "account");
    let mut state = auth.state();
    for delay in DELAYS_MS {
        tokio::time::sleep(Duration::from_millis(delay)).await;
        if auth.token().as_deref() != Some(token.as_str()) {
            break;
        }
        match fetch_me(http, api_base, &token).await {
            Ok(account) => {
                // A trial also resolves as Pro; activation is only complete
                // once a paid subscription replaces it.
                let is_pro = account.plan.eq_ignore_ascii_case("pro") && account.trial.is_none();
                auth.set_account(account);
                state = auth.state();
                emit_account_changed(app, &state);
                if is_pro {
                    break;
                }
            }
            Err(error) if error.kind == ApiErrorKind::Unauthorized => {
                auth.sign_out_if_token(&token);
                state = auth.state();
                emit_account_changed(app, &state);
                break;
            }
            Err(error) => eprintln!("[ray] could not refresh the account after billing: {error}"),
        }
    }
    emit_billing_activating(app, false);
    state
}

fn emit_billing_activating(app: &AppHandle, active: bool) {
    let _ = app.emit("billing-activating", active);
}

pub async fn exchange_code(
    http: &reqwest::Client,
    api_base: &str,
    code: &str,
    verifier: &str,
) -> Result<String, ApiError> {
    let mut payload = json!({ "code": code, "verifier": verifier });
    // Omitted when the registry value cannot be read: sign-in still succeeds,
    // the Worker simply grants no trial without a device id. The raw GUID is
    // never sent or logged.
    if let Some(device_id) = crate::device::device_id() {
        payload["device_id"] = Value::String(device_id);
    }
    let response = http
        .post(api::endpoint(api_base, "/api/desktop/token"))
        .json(&payload)
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
            // Only the token this request actually used may be cleared.
            auth.sign_out_if_token(&token);
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
        return Err(ApiError::from_http(status.as_u16(), &text));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| ApiError::other(format!("Ray sent invalid JSON: {error}")))?;
    value
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ApiError::other("Ray returned no billing URL"))
}

/// Common handling for checkout and the portal: a 401 clears that request's
/// session (only if its token is still the current one).
fn billing_error(app: &AppHandle, auth: &Auth, token: &str, error: ApiError) -> String {
    if error.kind == ApiErrorKind::Unauthorized && auth.sign_out_if_token(token) {
        emit_account_changed(app, &auth.state());
    }
    error.to_string()
}

fn emit_account_changed(app: &AppHandle, state: &AuthState) {
    let _ = app.emit("account-changed", state.clone());
}

/// Billing URLs come from the server, but opening an arbitrary scheme in the
/// system browser is still a dangerous primitive. Production allows HTTPS
/// only; debug builds also allow a local billing test page.
pub fn billing_url_is_safe(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    if parsed.scheme() == "https" {
        return true;
    }
    if cfg!(debug_assertions) && parsed.scheme() == "http" {
        return parsed
            .host_str()
            .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "::1"));
    }
    false
}

fn open_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("Could not open your browser: {error}"))
}

fn open_billing_url(app: &AppHandle, url: &str) -> Result<(), String> {
    if !billing_url_is_safe(url) {
        return Err("Ray returned an unsafe billing URL; not opening it.".into());
    }
    open_browser(app, url)
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
    let url = auth.begin_sign_in(&dictation.site_url())?;
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
    let url = match billing_url(
        dictation.http(),
        &dictation.api_base(),
        &token,
        "/api/billing/checkout",
        Some(json!({ "interval": interval })),
    )
    .await
    {
        Ok(url) => url,
        Err(error) if error.code.as_deref() == Some("already_subscribed") => {
            // Refresh so the Account page shows Pro, and tell the user why
            // checkout did not open.
            if let Ok(state) = refresh(&auth, dictation.http(), &dictation.api_base()).await {
                emit_account_changed(&app, &state);
            } else {
                emit_account_changed(&app, &auth.state());
            }
            return Err("You're already on Pro.".into());
        }
        Err(error) if error.code.as_deref() == Some("billing_issue") => {
            // Decision 9: the account needs a payment-method fix, so send the
            // user to the portal instead of a second checkout.
            if let Ok(state) = refresh(&auth, dictation.http(), &dictation.api_base()).await {
                emit_account_changed(&app, &state);
            }
            let portal = billing_url(
                dictation.http(),
                &dictation.api_base(),
                &token,
                "/api/billing/portal",
                None,
            )
            .await;
            if let Ok(portal) = portal {
                open_billing_url(&app, &portal)?;
            }
            return Err("Payment issue: update your card in the billing portal.".into());
        }
        Err(error) => return Err(billing_error(&app, &auth, &token, error)),
    };
    open_billing_url(&app, &url)
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
    .map_err(|error| billing_error(&app, &auth, &token, error))?;
    open_billing_url(&app, &url)
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
        let auth = Auth::new(None);
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
        let auth = Auth::new(None);
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
    fn a_trial_is_treated_as_pro_and_never_blocked() {
        let account = Account {
            plan: "pro".into(),
            trial: Some(Trial {
                ends_at: Some("2026-11-23T12:00:00Z".into()),
            }),
            usage: Usage {
                words_used: 500_000,
                words_limit: None,
                ..Usage::default()
            },
            ..Account::default()
        };
        assert!(account.trial_active());
        assert!(!account.starter_is_over_limit());

        // The new `/api/me` fields must deserialize and be optional for old
        // or partial responses.
        let parsed: Account = serde_json::from_str(
            r#"{"plan":"pro","trial":{"ends_at":"2026-11-23T12:00:00Z"},"free_blocked":true,"user":{"id":"u","email":""}}"#,
        )
        .expect("trial fields must deserialize");
        assert!(parsed.trial_active());
        assert_eq!(
            parsed.trial.unwrap().ends_at.as_deref(),
            Some("2026-11-23T12:00:00Z")
        );
        assert!(parsed.free_blocked);
        let legacy: Account =
            serde_json::from_str(r#"{"plan":"starter","user":{"id":"u"}}"#).unwrap();
        assert!(!legacy.trial_active());
        assert!(!legacy.free_blocked);
    }

    #[test]
    fn an_account_with_a_null_or_empty_email_still_loads() {
        let null_email: Account = serde_json::from_str(
            r#"{"user":{"id":"user_1","email":null,"name":null},"plan":"starter"}"#,
        )
        .expect("null email must deserialize");
        assert_eq!(null_email.user.email, None);

        // The Worker now sends "" for an unknown email; keep that too.
        let empty_email: Account =
            serde_json::from_str(r#"{"user":{"id":"user_1","email":""},"plan":"starter"}"#)
                .expect("empty email must deserialize");
        assert_eq!(empty_email.user.email.as_deref(), Some(""));

        let issue: Account = serde_json::from_str(
            r#"{"plan":"starter","billing_issue":"past_due","user":{"id":"u","email":"a@b.com"}}"#,
        )
        .expect("billing_issue must deserialize");
        assert_eq!(issue.billing_issue.as_deref(), Some("past_due"));
        let none: Account = serde_json::from_str(r#"{"plan":"pro","billing_issue":null}"#).unwrap();
        assert_eq!(none.billing_issue, None);
    }

    #[test]
    fn cached_usage_is_stale_once_the_reset_time_passes() {
        // 2026-11-09T00:00:00Z
        let reset = 1_794_182_400u64;
        let account = Account {
            plan: "starter".into(),
            usage: Usage {
                words_used: 1_000,
                words_limit: Some(1_000),
                resets_at: Some("2026-11-09T00:00:00Z".into()),
                ..Usage::default()
            },
            ..Account::default()
        };
        assert!(!account.usage_is_stale_at(reset - 1));
        assert!(account.usage_is_stale_at(reset));
        assert!(account.usage_is_stale_at(reset + 60));
        // Missing or unparseable timestamps are not treated as stale.
        let mut missing = account.clone();
        missing.usage.resets_at = None;
        assert!(!missing.usage_is_stale_at(reset));
        missing.usage.resets_at = Some("not a date".into());
        assert!(!missing.usage_is_stale_at(reset));
    }

    #[test]
    fn rfc3339_parsing_handles_offsets_and_fractions() {
        assert_eq!(
            parse_rfc3339_seconds("2026-11-09T00:00:00Z"),
            Some(1_794_182_400)
        );
        assert_eq!(
            parse_rfc3339_seconds("2026-11-09T00:00:00.000Z"),
            Some(1_794_182_400)
        );
        // 01:00+01:00 is the same instant as 00:00Z.
        assert_eq!(
            parse_rfc3339_seconds("2026-11-09T01:00:00+01:00"),
            Some(1_794_182_400)
        );
        assert_eq!(parse_rfc3339_seconds(""), None);
        assert_eq!(parse_rfc3339_seconds("2026-13-09T00:00:00Z"), None);
        assert_eq!(parse_rfc3339_seconds("2026-11-09 00:00:00Z"), None);
    }

    #[test]
    fn a_401_only_clears_the_token_that_made_the_request() {
        let auth = Auth::new(None);
        *auth.token.lock().unwrap() = Some("ray_new".into());
        auth.set_account(Account::default());

        // A stale request with the old token must not sign the user out.
        assert!(!auth.sign_out_if_token("ray_old"));
        assert_eq!(auth.token().as_deref(), Some("ray_new"));
        assert!(auth.account().is_some());

        // The token that made the request does clear it.
        assert!(auth.sign_out_if_token("ray_new"));
        assert_eq!(auth.token(), None);
        assert!(auth.account().is_none());
        // A second 401 for the same old token is a no-op.
        assert!(!auth.sign_out_if_token("ray_new"));
    }

    #[test]
    fn sign_out_marker_prevents_a_failed_credential_delete_from_signing_back_in() {
        let dir = std::env::temp_dir().join(format!(
            "ray-auth-marker-test-{}-{}",
            std::process::id(),
            random_token(6)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("signed-out");
        let auth = Auth::new(Some(marker.clone()));
        auth.sign_out_local();
        assert!(marker.exists(), "sign-out must persist its intent");

        // Even if a token is still readable from Credential Manager, a later
        // launch must stay signed out.
        let reloaded = Auth::new(Some(marker.clone()));
        reloaded.load_stored_token();
        assert!(reloaded.is_loaded());
        assert!(!reloaded.is_signed_in());

        // A successful sign-in removes the marker.
        reloaded.complete_sign_in("ray_fresh".into()).unwrap();
        assert!(!marker.exists());
        assert_eq!(reloaded.token().as_deref(), Some("ray_fresh"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn billing_urls_require_https_in_release_and_allow_local_debug() {
        assert!(billing_url_is_safe("https://checkout.creem.io/session"));
        assert!(!billing_url_is_safe("javascript:alert(1)"));
        assert!(!billing_url_is_safe("file:///C:/Windows/System32/calc.exe"));
        assert!(!billing_url_is_safe("not a url"));
        // Debug builds may use a local test page, never a remote http origin.
        assert_eq!(
            billing_url_is_safe("http://127.0.0.1:8787/billing"),
            cfg!(debug_assertions)
        );
        assert!(!billing_url_is_safe("http://example.com/billing"));
    }

    #[test]
    fn auth_state_serializes_for_the_webview() {
        let state = AuthState {
            signed_in: true,
            loaded: true,
            account: Some(Account {
                user: AccountUser {
                    id: "user_1".into(),
                    email: Some("a@b.com".into()),
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
        let auth = Auth::new(None);
        auth.set_account(Account {
            plan: "starter".into(),
            usage: Usage {
                words_used: 1_000,
                words_limit: Some(1_000),
                ..Usage::default()
            },
            ..Account::default()
        });
        assert_eq!(auth.block_reason(), Some("Sign in to Ray to dictate"));
        *auth.token.lock().unwrap() = Some("ray_test".into());
        assert_eq!(auth.block_reason(), Some("Weekly limit reached"));
    }
}
