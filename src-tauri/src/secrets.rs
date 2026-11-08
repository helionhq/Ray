//! The Ray device token lives in Windows Credential Manager under service
//! `ray`, account `session`.
//!
//! Users no longer hold provider API keys. Credentials from the AssemblyAI,
//! Vercel, and Groq integrations are removed on startup so a retired key can
//! never linger in the OS store with no UI to clear it.
//!
//! `RAY_DEVICE_TOKEN` is a development and selftest convenience only; release
//! builds never read the token from the environment.

const SERVICE: &str = "ray";
pub const SESSION: &str = "session";

/// Accounts Ray no longer uses. Startup deletes them from Credential Manager.
pub const RETIRED: &[&str] = &["groq", "assemblyai", "vercel"];

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|error| format!("Credential store: {error}"))
}

fn credential(account: &str) -> Option<String> {
    let entry = entry(account).ok()?;
    let value = entry.get_password().ok()?;
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn env_token() -> Option<String> {
    let value = std::env::var("RAY_DEVICE_TOKEN").ok()?;
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// The stored device token. Debug builds also accept `RAY_DEVICE_TOKEN` so the
/// app can be run against a local Worker without signing in.
pub fn device_token() -> Option<String> {
    credential(SESSION).or_else(|| {
        if cfg!(debug_assertions) {
            env_token()
        } else {
            None
        }
    })
}

/// The selftest path may use `RAY_DEVICE_TOKEN` in any build profile; it is the
/// headless replacement for the sign-in flow.
pub fn selftest_device_token() -> Option<String> {
    credential(SESSION).or_else(env_token)
}

pub fn save_device_token(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return clear_device_token();
    }
    entry(SESSION)?
        .set_password(value)
        .map_err(|error| format!("Could not save the Ray session: {error}"))
}

pub fn clear_device_token() -> Result<(), String> {
    let entry = entry(SESSION)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Deleting a credential that is not there is not an error.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Could not remove the Ray session: {error}")),
    }
}

/// One-time startup cleanup: delete credentials left behind by providers that
/// have been retired. Safe to call on every launch; a credential that is not
/// present is simply skipped, so only an actual removal is logged.
pub fn remove_retired_secrets() {
    for secret in RETIRED {
        match remove_secret_if_present(secret) {
            Ok(true) => eprintln!("[ray] removed retired credential: {secret}"),
            Ok(false) => {}
            Err(error) => {
                eprintln!("[ray] could not remove retired credential {secret}: {error}")
            }
        }
    }
}

/// Delete `secret` from the OS store, reporting whether it existed. A missing
/// entry is success (`false`); any other keyring error is returned so the
/// caller can log it without aborting startup.
fn remove_secret_if_present(secret: &str) -> Result<bool, String> {
    let entry = entry(secret)?;
    match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("Could not remove key: {error}")),
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn credential_manager_round_trip() {
        // A dedicated entry so the user's real session is never touched.
        let name = "ray-selftest-roundtrip";
        let entry = keyring::Entry::new(SERVICE, name).expect("open credential");
        entry
            .set_password("round-trip-value")
            .expect("store secret");
        assert_eq!(
            entry.get_password().expect("read secret"),
            "round-trip-value"
        );
        entry.delete_credential().expect("remove secret");
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }

    #[test]
    fn retired_secret_migration_is_idempotent() {
        // A dedicated entry so the user's real credentials are never touched.
        let name = "ray-retired-selftest";
        let entry = keyring::Entry::new(SERVICE, name).expect("open credential");
        entry.set_password("retired-value").expect("store secret");

        // First pass removes the entry and reports the removal.
        assert_eq!(remove_secret_if_present(name), Ok(true));
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));

        // Second pass is a no-op: a missing entry is success, not an error.
        assert_eq!(remove_secret_if_present(name), Ok(false));
    }

    #[test]
    fn every_retired_provider_is_removed() {
        for provider in ["groq", "assemblyai", "vercel"] {
            assert!(
                RETIRED.contains(&provider),
                "{provider} must be retired from Credential Manager"
            );
        }
    }
}
