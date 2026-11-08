//! Per-PC device identity for the free-account limit.
//!
//! The raw Windows `MachineGuid` never leaves this module: the app sends only
//! `base64url(SHA-256("ray-device-v1:" + guid))`, and the Worker stores a
//! second SHA-256 of that value. If the GUID cannot be read, the app omits
//! the id and the server grants no trial rather than failing sign-in.

use base64::Engine;
use sha2::Digest;

const URL_SAFE_NO_PAD: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

const DEVICE_ID_PREFIX: &str = "ray-device-v1:";

/// `base64url(SHA-256("ray-device-v1:" + guid))`, unpadded (43 characters).
pub fn device_id_from_guid(guid: &str) -> String {
    let digest = sha2::Sha256::digest(format!("{DEVICE_ID_PREFIX}{guid}").as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// The stable per-PC identifier sent with the desktop token exchange.
///
/// Reads `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` through the
/// 64-bit registry view (`KEY_WOW64_64KEY`) so a 32-bit process sees the same
/// value as a 64-bit one. Returns `None` when the value is missing or empty;
/// the app then signs in normally and simply gets no trial.
pub fn device_id() -> Option<String> {
    let guid = read_machine_guid()?;
    let guid = guid.trim();
    if guid.is_empty() {
        return None;
    }
    Some(device_id_from_guid(guid))
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
        if let Some(id) = device_id() {
            assert_eq!(id.len(), 43);
            assert!(id.chars().all(|character| character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'));
        }
    }
}
