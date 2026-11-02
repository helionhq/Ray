//! Clipboard-preserving paste.
//!
//! Saves whatever was on the clipboard, puts the transcript there, sends
//! Ctrl+V to the focused window, then restores the original clipboard.
//!
//! Restoring too early is the dangerous part: a busy target (Electron app,
//! Office, a loaded browser) can read the clipboard hundreds of milliseconds
//! after Ctrl+V, and would then paste whatever was there before. So the
//! restore is deferred adaptively, happens off the hot path, and only runs
//! while the clipboard still holds our transcript (checked with the clipboard
//! sequence number *and* the text itself). If anything else touched the
//! clipboard meanwhile its contents win.
//!
//! Transient transcript text is also marked so Windows clipboard history
//! (Win+V) and cloud clipboard do not collect every dictation.

use std::sync::Mutex;
use std::thread::sleep;
use std::time::Duration;

use arboard::{Clipboard, ImageData};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
use windows::Win32::Graphics::Gdi::{BITMAPV5HEADER, BI_BITFIELDS, LCS_GM_IMAGES};
use windows::Win32::System::DataExchange::{
    CloseClipboard, CountClipboardFormats, EmptyClipboard, GetClipboardData,
    GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL, VK_LMENU, VK_MENU, VK_RMENU,
    VK_V,
};

use crate::windows_util;

const CF_UNICODETEXT: u32 = 13;
const CF_DIBV5: u32 = 17;

/// How long the transcript stays on the clipboard before the previous content
/// is put back. Electron/Office/browser targets are given more time; they
/// dispatch the paste on their UI thread and can be busy for a while.
const DEFAULT_RESTORE_MS: u64 = 1_500;
const SLOW_RESTORE_MS: u64 = 5_000;

/// Processes that are known to read the clipboard late under load.
const SLOW_PASTE_TARGETS: &[&str] = &[
    "brave",
    "chrome",
    "code",
    "cursor",
    "devenv",
    "discord",
    "excel",
    "figma",
    "firefox",
    "idea64",
    "ms-teams",
    "msedge",
    "notion",
    "obsidian",
    "opera",
    "outlook",
    "powerpnt",
    "slack",
    "spotify",
    "sublime_text",
    "teams",
    "telegram",
    "vivaldi",
    "whatsapp",
    "winword",
];

enum Saved {
    Text(String),
    Image(ImageData<'static>),
    /// There was nothing on the clipboard.
    Empty,
    /// Files, rich content, or something else we cannot put back. The
    /// transcript is left on the clipboard and the user is told.
    Unknown,
}

struct PendingRestore {
    saved: Saved,
    text: String,
    sequence: u32,
}

/// The paste whose clipboard content is still waiting to be restored. The
/// mutex is held while restoring so a new dictation cannot save our transient
/// transcript as if it were the user's clipboard.
static PENDING: Mutex<Option<PendingRestore>> = Mutex::new(None);

fn pending() -> std::sync::MutexGuard<'static, Option<PendingRestore>> {
    PENDING.lock().unwrap_or_else(|error| error.into_inner())
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
    if let Ok(text) = with_clipboard(|clipboard| clipboard.get_text()) {
        if !text.is_empty() {
            return Saved::Text(text);
        }
    }
    if let Ok(image) = with_clipboard(|clipboard| clipboard.get_image()) {
        return Saved::Image(image);
    }
    if clipboard_is_empty() {
        Saved::Empty
    } else {
        Saved::Unknown
    }
}

fn restore_clipboard(saved: Saved) {
    if open_clipboard().is_err() {
        return;
    }
    let result = restore_clipboard_locked(saved);
    unsafe {
        let _ = CloseClipboard();
    };
    if let Err(error) = result {
        eprintln!("[ray] could not restore the clipboard: {error}");
    }
}

/// Restores `saved` on an already-open clipboard.
fn restore_clipboard_locked(saved: Saved) -> Result<(), String> {
    match saved {
        Saved::Text(text) => {
            // Excluding the restore from history avoids adding a duplicate of
            // content that was already in clipboard history.
            write_clipboard_text_locked(&text, true)
        }
        Saved::Image(image) => write_clipboard_image_locked(&image),
        Saved::Empty => unsafe { EmptyClipboard() }.map_err(|error| format!("Clipboard: {error}")),
        // Unknown content cannot be restored; leave the transcript in place
        // rather than destroying it with a half-restore.
        Saved::Unknown => Ok(()),
    }
}

/// Puts `text` on the clipboard without losing the original if this fails.
fn set_clipboard_text(text: &str, exclude_from_history: bool) -> Result<u32, String> {
    open_clipboard()?;
    let result = write_clipboard_text_locked(text, exclude_from_history);
    unsafe {
        let _ = CloseClipboard();
    };
    result?;
    Ok(unsafe { GetClipboardSequenceNumber() })
}

/// Empties the clipboard and puts `text` there. The caller must hold the
/// clipboard open: the deferred restore checks ownership and writes under one
/// lock so another app cannot copy in between.
fn write_clipboard_text_locked(text: &str, exclude_from_history: bool) -> Result<(), String> {
    if text.is_empty() {
        return unsafe { EmptyClipboard() }.map_err(|error| format!("Clipboard: {error}"));
    }
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = unsafe {
        std::slice::from_raw_parts(
            wide.as_ptr() as *const u8,
            wide.len() * std::mem::size_of::<u16>(),
        )
    };
    let text_handle = unsafe { alloc_bytes(bytes) }?;
    let markers = if exclude_from_history {
        history_markers()
    } else {
        Vec::new()
    };

    if let Err(error) = unsafe { EmptyClipboard() } {
        unsafe {
            let _ = windows::Win32::Foundation::GlobalFree(Some(text_handle));
            for (_, handle) in markers {
                let _ = windows::Win32::Foundation::GlobalFree(Some(handle));
            }
        }
        return Err(format!("Could not clear the clipboard: {error}"));
    }

    if let Err(error) = unsafe { SetClipboardData(CF_UNICODETEXT, Some(HANDLE(text_handle.0))) } {
        unsafe {
            let _ = windows::Win32::Foundation::GlobalFree(Some(text_handle));
            for (_, handle) in markers {
                let _ = windows::Win32::Foundation::GlobalFree(Some(handle));
            }
        }
        return Err(format!(
            "Could not put the transcript on the clipboard: {error}"
        ));
    }

    // The system owns the text now. History markers are best-effort; a failure
    // here only means the transcript may appear in Win+V.
    for (format, handle) in markers {
        if unsafe { SetClipboardData(format, Some(HANDLE(handle.0))) }.is_err() {
            unsafe {
                let _ = windows::Win32::Foundation::GlobalFree(Some(handle));
            };
        }
    }
    Ok(())
}

/// Restores a saved image on an already-open clipboard.
///
/// arboard's `set_image` opens the clipboard itself, so it cannot be used
/// without dropping the lock between the ownership check and the write. Write
/// the same CF_DIBV5 payload arboard produces instead (32-bit BGR(A),
/// bottom-up rows, sRGB), which is what the clipboard reported when it was
/// saved. Word/WordPad reject a negative (top-down) height.
fn write_clipboard_image_locked(image: &ImageData<'static>) -> Result<(), String> {
    let Some(pixels) = image
        .width
        .checked_mul(image.height)
        .and_then(|count| count.checked_mul(4))
    else {
        return Err("Clipboard image dimensions are too large".into());
    };
    if image.bytes.len() < pixels {
        return Err("Clipboard image data is incomplete".into());
    }
    let header_size = std::mem::size_of::<BITMAPV5HEADER>();
    let Some(total) = header_size.checked_add(pixels) else {
        return Err("Clipboard image dimensions are too large".into());
    };
    let mut data = vec![0u8; total];
    // constants::LCS_sRGB is not exposed by the windows crate.
    #[allow(non_upper_case_globals)]
    const LCS_sRGB: u32 = 0x7352_4742;
    let header = BITMAPV5HEADER {
        bV5Size: header_size as u32,
        bV5Width: image.width as i32,
        bV5Height: image.height as i32,
        bV5Planes: 1,
        bV5BitCount: 32,
        bV5Compression: BI_BITFIELDS,
        bV5SizeImage: pixels as u32,
        bV5RedMask: 0x00ff_0000,
        bV5GreenMask: 0x0000_ff00,
        bV5BlueMask: 0x0000_00ff,
        bV5AlphaMask: 0xff00_0000,
        bV5CSType: LCS_sRGB,
        bV5Intent: LCS_GM_IMAGES as u32,
        ..Default::default()
    };
    unsafe {
        std::ptr::copy_nonoverlapping(
            (&header as *const BITMAPV5HEADER).cast::<u8>(),
            data.as_mut_ptr(),
            header_size,
        );
    }
    // arboard hands back top-down RGBA; DIB rows are bottom-up and the masks
    // above put the channels in B, G, R, A order in memory.
    let row = image.width * 4;
    for y in 0..image.height {
        let source = &image.bytes[y * row..y * row + row];
        let target = header_size + (image.height - 1 - y) * row;
        for x in 0..image.width {
            let from = x * 4;
            let to = target + from;
            data[to] = source[from + 2];
            data[to + 1] = source[from + 1];
            data[to + 2] = source[from];
            data[to + 3] = source[from + 3];
        }
    }
    let handle = unsafe { alloc_bytes(&data) }?;
    // The transcript is still on the clipboard; clear it so the image is the
    // only thing the target can paste.
    if let Err(error) = unsafe { EmptyClipboard() } {
        unsafe {
            let _ = windows::Win32::Foundation::GlobalFree(Some(handle));
        }
        return Err(format!("Could not clear the clipboard: {error}"));
    }
    if let Err(error) = unsafe { SetClipboardData(CF_DIBV5, Some(HANDLE(handle.0))) } {
        unsafe {
            let _ = windows::Win32::Foundation::GlobalFree(Some(handle));
        }
        return Err(format!("Could not restore the clipboard image: {error}"));
    }
    Ok(())
}

/// Allocates the three clipboard formats Windows uses to keep transient
/// content out of clipboard history and the cloud clipboard.
fn history_markers() -> Vec<(u32, HGLOBAL)> {
    let zero = 0u32.to_ne_bytes();
    let mut out = Vec::with_capacity(3);
    for name in [
        "CanIncludeInClipboardHistory",
        "CanUploadToCloudClipboard",
        "ExcludeClipboardContentFromMonitorProcessing",
    ] {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let format = unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) };
        if format == 0 {
            continue;
        }
        if let Ok(handle) = unsafe { alloc_bytes(&zero) } {
            out.push((format, handle));
        }
    }
    out
}

unsafe fn alloc_bytes(bytes: &[u8]) -> Result<HGLOBAL, String> {
    let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }
        .map_err(|error| format!("Clipboard memory: {error}"))?;
    let pointer = unsafe { GlobalLock(handle) };
    if pointer.is_null() {
        unsafe {
            let _ = windows::Win32::Foundation::GlobalFree(Some(handle));
        };
        return Err("Could not lock clipboard memory".into());
    }
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer as *mut u8, bytes.len()) };
    // The last unlock reports a zero return even on success; ignore it.
    let _ = unsafe { GlobalUnlock(handle) };
    Ok(handle)
}

fn open_clipboard() -> Result<(), String> {
    // EmptyClipboard associates the clipboard with the window passed to
    // OpenClipboard. With NULL, Windows sets the owner to NULL and every
    // following SetClipboardData fails, so always open on Ray's window.
    let owner = windows_util::clipboard_owner()
        .map(|hwnd| HWND(hwnd as *mut std::ffi::c_void))
        .ok_or_else(|| "Could not create Ray's clipboard window".to_string())?;
    let mut last = String::new();
    for attempt in 0..6 {
        match unsafe { OpenClipboard(Some(owner)) } {
            Ok(()) => return Ok(()),
            Err(error) => last = error.to_string(),
        }
        if attempt < 5 {
            sleep(Duration::from_millis(20));
        }
    }
    Err(format!("Clipboard is busy: {last}"))
}

fn count_clipboard_formats() -> Option<i32> {
    if open_clipboard().is_err() {
        return None;
    }
    let count = unsafe { CountClipboardFormats() };
    unsafe {
        let _ = CloseClipboard();
    };
    Some(count)
}

fn clipboard_is_empty() -> bool {
    count_clipboard_formats() == Some(0)
}

/// Public entry point for the history page's copy button.
pub fn copy_text(text: &str) -> Result<(), String> {
    copy_text_with(text, LineEndings::Preserve)
}

/// Copy with the clipboard line-ending convention the caller needs.
pub fn copy_text_with(text: &str, line_endings: LineEndings) -> Result<(), String> {
    // A pending dictation restore must not undo the user's deliberate copy.
    flush_pending_restore();
    let text = prepare_clipboard_text(text, line_endings);
    set_clipboard_text(&text, false).map(|_| ())
}

/// How line breaks are written to CF_UNICODETEXT. Windows text controls expect
/// CRLF; `Preserve` keeps the bytes exactly as they were (Clean's existing
/// behaviour) while `CrLf` normalises Structured's paragraphs and lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEndings {
    Preserve,
    CrLf,
}

fn prepare_clipboard_text(text: &str, line_endings: LineEndings) -> std::borrow::Cow<'_, str> {
    match line_endings {
        LineEndings::Preserve => std::borrow::Cow::Borrowed(text),
        LineEndings::CrLf => std::borrow::Cow::Owned(with_crlf(text)),
    }
}

/// Normalise every line break to CRLF. Existing CRLF and lone CR are handled,
/// so the result is idempotent.
fn with_crlf(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '\r' => {
                if characters.peek() == Some(&'\n') {
                    characters.next();
                }
                out.push_str("\r\n");
            }
            '\n' => out.push_str("\r\n"),
            other => out.push(other),
        }
    }
    out
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PasteOutcome {
    /// True when the clipboard held files/rich content that cannot be put
    /// back, so the transcript was left there.
    pub previous_clipboard_lost: bool,
}

/// Pastes `text` into the focused window. Returns once Ctrl+V has been sent;
/// the previous clipboard is restored afterwards on a background thread.
///
/// `target` is the window the dictation started in (`None` when Ray could not
/// identify one). Ray refuses to type into a different window: the caller
/// gets an error and keeps the text instead, so a window switch during
/// transcription never inserts the transcript into the wrong app.
///
/// `keep_on_clipboard` leaves the transcript on the clipboard instead of
/// restoring the previous content. Used when History could not save it and the
/// clipboard is the user's remaining copy.
pub fn paste_text(
    text: &str,
    target: Option<isize>,
    keep_on_clipboard: bool,
    line_endings: LineEndings,
) -> Result<PasteOutcome, String> {
    if text.trim().is_empty() {
        return Ok(PasteOutcome::default());
    }
    flush_pending_restore();

    // Fail with something actionable rather than sending keystrokes that
    // Windows will silently drop.
    if let Some(reason) = windows_util::paste_blocker() {
        return Err(reason);
    }

    let clipboard_text = prepare_clipboard_text(text, line_endings);
    let saved = save_clipboard();
    let previous_clipboard_lost = matches!(saved, Saved::Unknown);
    if let Err(error) = set_clipboard_text(&clipboard_text, true) {
        restore_clipboard(saved);
        return Err(error);
    }

    // Give the clipboard owner a beat to publish before the target reads it.
    sleep(Duration::from_millis(45));
    // Check as late as possible: cleanup can take seconds, and the user may
    // have switched windows or closed the one they started in. With no known
    // target, pasting into whatever is focused is the only option (the
    // blocker check above still rules out windows that cannot receive input).
    if let Some(target) = target {
        if windows_util::foreground_hwnd() != Some(target) {
            restore_clipboard(saved);
            return Err("the window you started dictating in is no longer focused".into());
        }
    }
    if let Err(error) = send_ctrl_v() {
        restore_clipboard(saved);
        return Err(error);
    }

    if keep_on_clipboard {
        return Ok(PasteOutcome {
            previous_clipboard_lost,
        });
    }

    let sequence = unsafe { GetClipboardSequenceNumber() };
    let delay = restore_delay(windows_util::foreground_process_name().as_deref());
    {
        let mut slot = pending();
        // Normally empty because paste_text flushes first; replacing is still
        // safe because the old sequence can never match again.
        *slot = Some(PendingRestore {
            saved,
            text: clipboard_text.into_owned(),
            sequence,
        });
    }
    schedule_restore(sequence, delay);
    Ok(PasteOutcome {
        previous_clipboard_lost,
    })
}

fn restore_delay(process: Option<&str>) -> Duration {
    let slow = process.is_some_and(|process| {
        let process = process.to_ascii_lowercase();
        SLOW_PASTE_TARGETS.contains(&process.as_str())
    });
    Duration::from_millis(if slow {
        SLOW_RESTORE_MS
    } else {
        DEFAULT_RESTORE_MS
    })
}

fn schedule_restore(sequence: u32, delay: Duration) {
    let _ = std::thread::Builder::new()
        .name("ray-clipboard-restore".into())
        .spawn(move || {
            sleep(delay);
            take_and_restore(Some(sequence));
        });
}

/// Restores the saved clipboard if it is still the one this paste owns.
/// `expected_sequence` is `None` to flush unconditionally (new paste, copy,
/// quit).
fn take_and_restore(expected_sequence: Option<u32>) {
    let mut slot = pending();
    let Some(current) = slot.as_ref() else {
        return;
    };
    if let Some(expected) = expected_sequence {
        if current.sequence != expected {
            // A newer paste owns the clipboard now.
            return;
        }
    }
    let Some(current) = slot.take() else {
        return;
    };
    // Hold the PENDING lock through the restore so a new paste cannot read our
    // transient transcript as the previous clipboard.
    //
    // The Win32 clipboard lock spans the ownership check and the write too.
    // Checking with arboard and then reopening would let another app copy in
    // between (the open retries make that window wider), and Ray would then
    // overwrite the newer copy with the old one.
    if open_clipboard().is_err() {
        // Could not take the lock; leave the transcript where it is rather
        // than risk clobbering content we did not inspect, and keep the saved
        // clipboard so a later flush (or quit) can try again.
        *slot = Some(current);
        return;
    }
    let still_ours = clipboard_still_holds_locked(&current);
    let result = if still_ours {
        restore_clipboard_locked(current.saved)
    } else {
        Ok(())
    };
    unsafe {
        let _ = CloseClipboard();
    };
    if let Err(error) = result {
        eprintln!("[ray] could not restore the clipboard: {error}");
    }
}

/// Must be called with the clipboard open. The sequence check catches another
/// app copying; the text check catches apps that rewrite the same content
/// without (or before) bumping the counter.
fn clipboard_still_holds_locked(pending: &PendingRestore) -> bool {
    let sequence = unsafe { GetClipboardSequenceNumber() };
    if pending.sequence != 0 && sequence != pending.sequence {
        return false;
    }
    matches!(clipboard_text_locked(), Some(text) if text == pending.text)
}

/// Reads CF_UNICODETEXT from the already-open clipboard.
fn clipboard_text_locked() -> Option<String> {
    unsafe {
        let handle = GetClipboardData(CF_UNICODETEXT).ok()?;
        let pointer = GlobalLock(HGLOBAL(handle.0));
        if pointer.is_null() {
            return None;
        }
        let wide = pointer as *const u16;
        // Another app's CF_UNICODETEXT may be malformed; never read past the
        // allocation looking for the terminator.
        let limit = GlobalSize(HGLOBAL(handle.0)) / std::mem::size_of::<u16>();
        let mut length = 0usize;
        while length < limit && *wide.add(length) != 0 {
            length += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(wide, length));
        let _ = GlobalUnlock(HGLOBAL(handle.0));
        Some(text)
    }
}

/// Puts the previous clipboard back right away. Used before a new paste, a
/// deliberate copy, and on quit.
pub fn flush_pending_restore() {
    take_and_restore(None);
}

fn send_ctrl_v() -> Result<(), String> {
    // Right Alt may still be physically or logically down when a fast stop
    // reaches the paste stage. Clear both Alt keys first: otherwise Ctrl+V is
    // Ctrl+Alt+V (AltGr+V) on AltGr layouts and types a character instead of
    // pasting. These synthetic edges are ignored by Ray's own hook.
    let alt_keys = [VK_RMENU, VK_LMENU, VK_MENU];
    let mut inputs = Vec::with_capacity(alt_keys.len() + 4);
    for vk in alt_keys {
        inputs.push(key_input(vk, vk == VK_RMENU, true));
    }
    inputs.push(key_input(VK_CONTROL, false, false));
    inputs.push(key_input(VK_V, false, false));
    inputs.push(key_input(VK_V, false, true));
    inputs.push(key_input(VK_CONTROL, false, true));

    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        return Err("Could not send the paste keystroke".into());
    }
    Ok(())
}

fn key_input(key: VIRTUAL_KEY, extended: bool, up: bool) -> INPUT {
    let mut flags = if up {
        KEYEVENTF_KEYUP
    } else {
        KEYBD_EVENT_FLAGS(0)
    };
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: crate::hotkey::RAY_INJECTED,
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_targets_get_a_longer_restore_window() {
        assert_eq!(
            restore_delay(Some("slack")),
            Duration::from_millis(SLOW_RESTORE_MS)
        );
        assert_eq!(
            restore_delay(Some("WINWORD")),
            Duration::from_millis(SLOW_RESTORE_MS)
        );
        assert_eq!(
            restore_delay(Some("notepad")),
            Duration::from_millis(DEFAULT_RESTORE_MS)
        );
        assert_eq!(
            restore_delay(None),
            Duration::from_millis(DEFAULT_RESTORE_MS)
        );
    }

    #[test]
    fn structured_line_endings_become_crlf_for_the_clipboard() {
        assert_eq!(with_crlf("a\nb"), "a\r\nb");
        assert_eq!(with_crlf("a\r\nb"), "a\r\nb");
        assert_eq!(with_crlf("a\rb"), "a\r\nb");
        assert_eq!(with_crlf("a\n\n- one\n- two"), "a\r\n\r\n- one\r\n- two");
        // Preserve is a no-op, so Clean's clipboard bytes are unchanged.
        assert_eq!(
            prepare_clipboard_text("a\nb", LineEndings::Preserve),
            "a\nb"
        );
        assert_eq!(prepare_clipboard_text("a\nb", LineEndings::CrLf), "a\r\nb");
    }
}
