//! Clipboard-preserving paste.
//!
//! Saves whatever was on the clipboard, puts the transcript there, sends
//! Ctrl+V to the focused window, then restores the original clipboard. The bar
//! never takes focus, so the target app remains the foreground window.

use std::thread::sleep;
use std::time::Duration;

use arboard::{Clipboard, ImageData};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_CONTROL, VK_V,
};

enum Saved {
    Text(String),
    Image(ImageData<'static>),
    /// The clipboard held something we cannot read back (files, rich content,
    /// or nothing at all). Leave it untouched on restore.
    Unknown,
}

fn with_clipboard<T>(
    mut action: impl FnMut(&mut Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, String> {
    let mut last = String::new();
    for attempt in 0..5 {
        match Clipboard::new() {
            Ok(mut clipboard) => match action(&mut clipboard) {
                Ok(value) => return Ok(value),
                Err(error) => last = error.to_string(),
            },
            Err(error) => last = error.to_string(),
        }
        if attempt < 4 {
            sleep(Duration::from_millis(25));
        }
    }
    Err(format!("Clipboard is busy: {last}"))
}

fn save_clipboard() -> Saved {
    let text = with_clipboard(|clipboard| clipboard.get_text());
    if let Ok(text) = text {
        return Saved::Text(text);
    }
    let image = with_clipboard(|clipboard| clipboard.get_image());
    if let Ok(image) = image {
        return Saved::Image(image);
    }
    Saved::Unknown
}

fn restore_clipboard(saved: Saved) {
    match saved {
        Saved::Text(text) => {
            let _ = with_clipboard(move |clipboard| clipboard.set_text(text.clone()));
        }
        Saved::Image(image) => {
            let _ = with_clipboard(move |clipboard| clipboard.set_image(image.clone()));
        }
        // Unknown content cannot be restored; leave the clipboard as-is rather
        // than destroying it.
        Saved::Unknown => {}
    }
}

pub fn copy_text(text: &str) -> Result<(), String> {
    let text = text.to_string();
    with_clipboard(move |clipboard| clipboard.set_text(text.clone()))
}

/// Pastes `text` into the foreground window, restoring the previous clipboard
/// afterwards. Returns once the clipboard has been restored.
pub fn paste_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let saved = save_clipboard();
    let text = text.to_string();
    let result = with_clipboard(move |clipboard| clipboard.set_text(text.clone()));
    if let Err(error) = result {
        restore_clipboard(saved);
        return Err(error);
    }

    // Give the clipboard owner a beat to publish before the target reads it.
    sleep(Duration::from_millis(45));
    send_ctrl_v()?;
    sleep(Duration::from_millis(240));
    restore_clipboard(saved);
    Ok(())
}

fn send_ctrl_v() -> Result<(), String> {
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                time: 0,
                dwExtraInfo: crate::hotkey::RAY_INJECTED,
            },
        },
    };
    let inputs = [
        key(VK_CONTROL, false),
        key(VK_V, false),
        key(VK_V, true),
        key(VK_CONTROL, true),
    ];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        return Err("Could not send the paste keystroke".into());
    }
    Ok(())
}
