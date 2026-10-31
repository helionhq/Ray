//! Global Right Alt hotkey via a low-level keyboard hook (WH_KEYBOARD_LL).
//!
//! Right Alt is a modifier, so the hook swallows its press and release and
//! taps an unassigned key on release; that keeps Windows and the focused app
//! from opening the menu bar or Start menu. If another key joins while Right
//! Alt is held (AltGr, Alt+Tab), the recording is cancelled and a synthetic
//! Right Alt down is replayed so the chord still reaches the app.
//!
//! Escape while recording cancels and is swallowed.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, OnceLock};
use std::thread;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_ESCAPE, VK_RMENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
    KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT,
    WM_SYSKEYDOWN, WM_SYSKEYUP,
};

#[derive(Clone, Copy, Debug)]
pub enum HotkeyEvent {
    Toggle,
    Cancel,
}

static SENDER: OnceLock<UnboundedSender<HotkeyEvent>> = OnceLock::new();
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
static ALT_DOWN: AtomicBool = AtomicBool::new(false);
static ALT_CHORD: AtomicBool = AtomicBool::new(false);
static CAPTURING: AtomicBool = AtomicBool::new(false);

/// Marks the synthetic keys Ray itself sends (the release mask and paste) so
/// the hook ignores them. Other tools' injected keys are still handled, which
/// also makes the hotkey testable with SendInput.
pub const RAY_INJECTED: usize = 0x5241_5901;

/// Set from the pipeline so Escape is only consumed while recording.
pub fn set_capturing(capturing: bool) {
    CAPTURING.store(capturing, Ordering::SeqCst);
}

pub fn install(sender: UnboundedSender<HotkeyEvent>) -> Result<(), String> {
    SENDER.set(sender).ok();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    thread::Builder::new()
        .name("ray-hotkey".into())
        .spawn(move || unsafe {
            let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) {
                Ok(hook) => hook,
                Err(error) => {
                    let _ =
                        ready_tx.send(Err(format!("Could not install the keyboard hook: {error}")));
                    return;
                }
            };
            HOOK_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
            let _ = ready_tx.send(Ok(()));
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {}
            let _ = UnhookWindowsHookEx(hook);
        })
        .map_err(|error| format!("Could not start the keyboard hook thread: {error}"))?;

    match ready_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("The keyboard hook did not install in time".into()),
    }
}

pub fn uninstall() {
    let thread_id = HOOK_THREAD.load(Ordering::SeqCst);
    if thread_id != 0 {
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return CallNextHookEx(None, code, wparam, lparam);
    }
    let event = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
    if event.flags.contains(LLKHF_INJECTED) && event.dwExtraInfo == RAY_INJECTED {
        return CallNextHookEx(None, code, wparam, lparam);
    }
    let message = wparam.0 as u32;
    let down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
    let up = message == WM_KEYUP || message == WM_SYSKEYUP;

    if event.vkCode == VK_RMENU.0 as u32 {
        if down {
            if ALT_DOWN.swap(true, Ordering::SeqCst) {
                return LRESULT(1); // auto-repeat
            }
            ALT_CHORD.store(false, Ordering::SeqCst);
            send(HotkeyEvent::Toggle);
            return LRESULT(1);
        }
        if up {
            let chord = ALT_CHORD.swap(false, Ordering::SeqCst);
            ALT_DOWN.store(false, Ordering::SeqCst);
            if chord {
                // The synthetic Alt down was delivered, so the real release must
                // reach the app too.
                return CallNextHookEx(None, code, wparam, lparam);
            }
            tap_unassigned_key();
            return LRESULT(1);
        }
        return CallNextHookEx(None, code, wparam, lparam);
    }

    if down && ALT_DOWN.load(Ordering::SeqCst) && !ALT_CHORD.load(Ordering::SeqCst) {
        // Another key joined the held modifier: this is a chord, not dictation.
        ALT_CHORD.store(true, Ordering::SeqCst);
        send(HotkeyEvent::Cancel);
        replay_right_alt_down();
        return CallNextHookEx(None, code, wparam, lparam);
    }

    if down && event.vkCode == VK_ESCAPE.0 as u32 && CAPTURING.load(Ordering::SeqCst) {
        send(HotkeyEvent::Cancel);
        return LRESULT(1);
    }

    CallNextHookEx(None, code, wparam, lparam)
}

fn send(event: HotkeyEvent) {
    if let Some(sender) = SENDER.get() {
        let _ = sender.send(event);
    }
}

unsafe fn key_event(vk: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: RAY_INJECTED,
            },
        },
    }
}

/// VK 0xE8 is unassigned. Tapping it flushes any pending modifier state in
/// the focused app without typing anything.
unsafe fn tap_unassigned_key() {
    let inputs = [
        key_event(0xE8, KEYBD_EVENT_FLAGS(0)),
        key_event(0xE8, KEYEVENTF_KEYUP),
    ];
    let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
}

/// Replays the Right Alt press that the hook swallowed, so AltGr and Alt
/// chords in the target app still see the modifier.
unsafe fn replay_right_alt_down() {
    let inputs = [key_event(VK_RMENU.0, KEYEVENTF_EXTENDEDKEY)];
    let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
}
