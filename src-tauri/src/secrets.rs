//! API keys live in Windows Credential Manager under service `ray`.
//!
//! Environment variables are a development fallback only (useful for headless
//! smoke tests); release builds never read keys from disk outside the OS store.

const SERVICE: &str = "ray";

pub const ASSEMBLYAI: &str = "assemblyai";
pub const VERCEL: &str = "vercel";

/// Providers Ray no longer supports. Their stored credentials must be removed
/// so a retired key cannot linger in Credential Manager with no UI to clear it.
pub const RETIRED: &[&str] = &["groq"];

pub fn env_names(secret: &str) -> &'static [&'static str] {
    match secret {
        ASSEMBLYAI => &["ASSEMBLYAI_API_KEY", "RAY_ASSEMBLYAI_API_KEY"],
        VERCEL => &[
            "VERCEL_AI_GATEWAY_KEY",
            "AI_GATEWAY_API_KEY",
            "RAY_VERCEL_AI_GATEWAY_KEY",
        ],
        _ => &[],
    }
}

fn entry(secret: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, secret).map_err(|error| format!("Credential store: {error}"))
}

/// Debug-only switch used by the headless first-run test: pretend Credential
/// Manager is empty so the env-var fallback (or the missing-key path) is
/// exercised without touching the user's real credentials.
fn ignore_stored_keys() -> bool {
    cfg!(debug_assertions) && std::env::var_os("RAY_TEST_IGNORE_STORED_KEYS").is_some()
}

pub fn get(secret: &str) -> Option<String> {
    if !ignore_stored_keys() {
        if let Ok(entry) = entry(secret) {
            if let Ok(value) = entry.get_password() {
                let value = value.trim().to_string();
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
    }
    for name in env_names(secret) {
        if let Ok(value) = std::env::var(name) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

pub fn has(secret: &str) -> bool {
    get(secret).is_some()
}

pub fn set(secret: &str, value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return delete(secret);
    }
    entry(secret)?
        .set_password(value)
        .map_err(|error| format!("Could not save key in Windows Credential Manager: {error}"))
}

pub fn delete(secret: &str) -> Result<(), String> {
    let entry = entry(secret)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Deleting a credential that is not there is not an error.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Could not remove key: {error}")),
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
        // A dedicated entry so the user's real AssemblyAI/Vercel keys are
        // never touched.
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
        // A dedicated entry so the user's real AssemblyAI/Vercel keys are
        // never touched.
        let name = "ray-retired-selftest";
        let entry = keyring::Entry::new(SERVICE, name).expect("open credential");
        entry.set_password("retired-value").expect("store secret");

        // First pass removes the entry and reports the removal.
        assert_eq!(remove_secret_if_present(name), Ok(true));
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));

        // Second pass is a no-op: a missing entry is success, not an error.
        assert_eq!(remove_secret_if_present(name), Ok(false));
    }
}
