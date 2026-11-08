//! Per-PC device identity for the free-account limit.
//!
//! The raw Windows `MachineGuid` never leaves this module: the app sends only
//! `base64url(SHA-256("ray-device-v1:" + guid))`, and the Worker stores a
//! second SHA-256 of that value. When the GUID cannot be read (managed or
//! privacy-hardened installs), a random per-install value is generated once
//! and persisted in the app-data directory, then hashed the same way. The
//! server requires the id, so sign-in never proceeds without one.

use std::fs;
use std::path::Path;

use base64::Engine;
use rand::Rng;
use sha2::Digest;

const URL_SAFE_NO_PAD: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

const DEVICE_ID_PREFIX: &str = "ray-device-v1:";
const FALLBACK_FILE_NAME: &str = "device-id";

/// `base64url(SHA-256("ray-device-v1:" + guid))`, unpadded (43 characters).
pub fn device_id_from_guid(guid: &str) -> String {
    let digest = sha2::Sha256::digest(format!("{DEVICE_ID_PREFIX}{guid}").as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// The stable per-PC identifier sent with the desktop token exchange.
///
/// Reads `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` through the
/// 64-bit registry view (`KEY_WOW64_64KEY`) so a 32-bit process sees the same
/// value as a 64-bit one. If the value is missing, empty, or unreadable, a
/// persisted random per-install id is used instead (when `app_data` is
/// available). Returns `None` only when neither source can produce an id; the
/// server requires the field, so the sign-in exchange then fails rather than
/// skipping the trial and the per-PC limit.
pub fn device_id(app_data: Option<&Path>) -> Option<String> {
    if let Some(guid) = read_machine_guid() {
        let guid = guid.trim();
        if !guid.is_empty() {
            return Some(device_id_from_guid(guid));
        }
    }
    app_data.and_then(fallback_device_id)
}

/// Reads the persisted fallback id, or creates it once. The stored value is
/// random; the id sent to the Worker is its hash, exactly like the GUID form,
/// so the Worker still sees only an opaque 43-character value.
fn fallback_device_id(app_data: &Path) -> Option<String> {
    let path = app_data.join(FALLBACK_FILE_NAME);
    if let Ok(text) = fs::read_to_string(&path) {
        let value = text.trim();
        if !value.is_empty() {
            return Some(device_id_from_guid(value));
        }
    }
    let mut buffer = [0u8; 32];
    rand::rng().fill_bytes(&mut buffer);
    let value = URL_SAFE_NO_PAD.encode(buffer);
    // If the file cannot be written, the id still works for this session.
    // The per-PC limit is client-supplied anyway, and the alternative is a
    // hard sign-in lockout.
    let _ = fs::write(&path, &value);
    Some(device_id_from_guid(&value))
}

#[cfg(windows)]
fn read_machine_guid() -> Option<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm
        .open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Cryptography",
            KEY_READ | KEY_WOW64_64KEY,
        )
        .ok()?;
    key.get_value::<String, _>("MachineGuid").ok()
}

#[cfg(not(windows))]
fn read_machine_guid() -> Option<String> {
    // Ray ships for Windows only; the hash is still unit-tested anywhere.
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUID: &str = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

    #[test]
    fn hashes_a_fixed_guid_into_a_stable_43_char_device_id() {
        let id = device_id_from_guid(GUID);
        assert_eq!(id, "g_PIfVWrCONbvyJKhh9y4fcKFKRHrAslMckauQBg4jg");
        assert_eq!(id.len(), 43);
        assert!(id.chars().all(|character| character.is_ascii_alphanumeric()
            || character == '-'
            || character == '_'));
        // Deterministic for the same PC, different for another.
        assert_eq!(id, device_id_from_guid(GUID));
        assert_ne!(id, device_id_from_guid("another-guid"));
    }

    #[test]
    fn never_exposes_the_raw_guid() {
        let id = device_id_from_guid(GUID);
        assert!(!id.contains(GUID));
        assert!(!id.to_ascii_lowercase().contains(&GUID.to_ascii_lowercase()));
    }

    #[test]
    fn host_device_id_is_well_formed_when_available() {
        if let Some(id) = device_id(None) {
            assert_eq!(id.len(), 43);
            assert!(id.chars().all(|character| character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'));
        }
    }

    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let mut buffer = [0u8; 8];
        rand::rng().fill_bytes(&mut buffer);
        let dir = std::env::temp_dir().join(format!(
            "ray-device-{tag}-{}",
            URL_SAFE_NO_PAD.encode(buffer)
        ));
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn fallback_id_is_generated_once_and_persisted() {
        let dir = scratch_dir("fallback");
        let first = fallback_device_id(&dir).expect("fallback id");
        let second = fallback_device_id(&dir).expect("fallback id");
        assert_eq!(first, second);
        assert_eq!(first.len(), 43);

        // The id is the hash of the stored random value, not the value itself.
        let stored = fs::read_to_string(dir.join(FALLBACK_FILE_NAME)).expect("stored id");
        assert_eq!(first, device_id_from_guid(stored.trim()));
        assert_ne!(first, stored.trim());

        let other = scratch_dir("other");
        assert_ne!(first, fallback_device_id(&other).expect("fallback id"));

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&other);
    }
}
