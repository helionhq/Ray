//! Global Right Alt hotkey via a low-level keyboard hook (WH_KEYBOARD_LL).
//!
//! Right Alt is a modifier, so the hook swallows its press and release; both
//! edges are consumed, which keeps Windows and the focused app from opening
//! the menu bar or Start menu. If another key joins while Right Alt is held
//! (AltGr, Alt+Tab), the recording is cancelled and the whole chord is
//! replayed with Right Alt down, so AltGr characters and Alt+Tab behave
//! normally instead of arriving as bare keys.
//!
//! While recording, a Right Alt press only *defers* the stop until the key is
//! released without a chord. The receiver handles events one at a time and a
//! stop-and-paste takes seconds, so a Toggle sent on the press would be
//! awaited before the chord's Cancel was even read; the recording would be
//! pasted rather than cancelled. A press while idle still starts immediately,
//! because latency matters there and Cancel-after-start already works.
//!
//! Nothing is ever injected from inside the hook itself: a slow callback
//! makes Windows silently remove a low-level hook. Replays go through a
//! dedicated worker thread. A thread timer re-installs the hook every few
//! minutes so a hook dropped by Windows (timeout, sleep/resume, lock/unlock)
//! starts working again without a restart.
//!
//! Escape while recording cancels and is swallowed.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tokio::sync::mpsc::UnboundedSender;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_ESCAPE, VK_RMENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, KillTimer, PostThreadMessageW, SetTimer, SetWindowsHookExW,
    UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_EXTENDED, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL,
    WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER,
};

#[derive(Clone, Copy, Debug)]
pub enum HotkeyEvent {
    /// `at` lets the pipeline drop presses that arrived while it was still
    /// finishing the previous dictation. For a stop deferred to the Right Alt
    /// release this is the release time, so a recording ended during the hold
    /// counts as stale rather than starting a new one.
    Toggle(Instant),
    Cancel,
}

/// Windows removes a low-level hook whose callback takes too long, and can
/// lose it across power transitions. Re-install on this cadence as a health
/// check; if it is still installed this is a no-op in practice.
const HOOK_REINSTALL_MS: u32 = 5 * 60 * 1_000;
const HOOK_TIMER_ID: usize = 1;

static SENDER: OnceLock<UnboundedSender<HotkeyEvent>> = OnceLock::new();
static REPLAY: OnceLock<mpsc::Sender<Replay>> = OnceLock::new();
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
static HOOK_JOIN: Mutex<Option<thread::JoinHandle<()>>> = Mutex::new(None);
static ALT_DOWN: AtomicBool = AtomicBool::new(false);
static ALT_CHORD: AtomicBool = AtomicBool::new(false);
/// A recording was in progress when Right Alt went down, so the stop waits for
/// the release: a chord key arriving first cancels instead.
static PENDING_STOP: AtomicBool = AtomicBool::new(false);
/// A key that was swallowed without a replay (Escape during a held Right Alt);
/// its release is swallowed too.
static SWALLOW_VK: AtomicU32 = AtomicU32::new(0);
static CAPTURING: AtomicBool = AtomicBool::new(false);
static INSTALL_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// Marks the synthetic keys Ray itself sends (Ctrl+V for paste and chord
/// replays) so the hook ignores them. Other tools' injected keys are still
/// handled, which also makes the hotkey testable with SendInput.
pub const RAY_INJECTED: usize = 0x5241_5901;

/// Set from the pipeline so Escape is only consumed while recording.
pub fn set_capturing(capturing: bool) {
    CAPTURING.store(capturing, Ordering::SeqCst);
}

#[derive(Clone, Copy)]
struct ChordKey {
    vk: u32,
    scan: u32,
    extended: bool,
}

enum Replay {
    MenuDown,
    KeyDown(ChordKey),
    KeyUp(ChordKey),
    MenuUp,
}

pub fn install(sender: UnboundedSender<HotkeyEvent>) -> Result<(), String> {
    SENDER.set(sender).ok();
    start_thread()
}

/// Restarts the keyboard hook, e.g. after the initial install failed or the
/// UI reports that the shortcut stopped working.
pub fn reinstall() -> Result<(), String> {
    if SENDER.get().is_none() {
        return Err("The hotkey receiver is not running".into());
    }
    start_thread()
}

fn start_thread() -> Result<(), String> {
    // The replay worker is shared by every hook installation.
    let _ = REPLAY.get_or_init(spawn_replay_worker);

    stop_thread();

    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let handle = thread::Builder::new()
        .name("ray-hotkey".into())
        .spawn(move || unsafe { hook_thread(ready_tx) })
        .map_err(|error| format!("Could not start the keyboard hook thread: {error}"))?;
    *HOOK_JOIN.lock().unwrap_or_else(|error| error.into_inner()) = Some(handle);

    match ready_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(_) => {
            stop_thread();
            Err("The keyboard hook did not install in time".into())
        }
    }
}

pub fn uninstall() {
    stop_thread();
}

fn stop_thread() {
    let thread_id = HOOK_THREAD.swap(0, Ordering::SeqCst);
    if thread_id != 0 {
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
    if let Some(handle) = HOOK_JOIN
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    {
        let _ = handle.join();
    }
}

/// `None` when the hook is healthy; otherwise a message for Settings.
pub fn status() -> Option<String> {
    if let Some(error) = INSTALL_ERROR
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
    {
        return Some(error);
    }
    if HOOK_THREAD.load(Ordering::SeqCst) == 0 {
        return Some("The keyboard hook is not running".into());
    }
    None
}

fn set_error(error: String) {
    eprintln!("[ray] {error}");
    *INSTALL_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error);
}

fn clear_error() {
    *INSTALL_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

unsafe fn install_hook() -> windows::core::Result<windows::Win32::UI::WindowsAndMessaging::HHOOK> {
    unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) }
}

unsafe fn hook_thread(ready_tx: mpsc::Sender<Result<(), String>>) {
    let mut hook = match unsafe { install_hook() } {
        Ok(hook) => hook,
        Err(error) => {
            let message = format!("Could not install the keyboard hook: {error}");
            set_error(message.clone());
            let _ = ready_tx.send(Err(message));
            return;
        }
    };
    HOOK_THREAD.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
    clear_error();
    let _ = ready_tx.send(Ok(()));

    // Thread timer: a WM_TIMER arrives even without a window.
    unsafe { SetTimer(None, HOOK_TIMER_ID, HOOK_REINSTALL_MS, None) };

    let mut message = MSG::default();
    loop {
        let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
        // 0 is WM_QUIT; -1 is an error, and BOOL(-1).as_bool() would be true.
        if result.0 == 0 || result.0 == -1 {
            break;
        }
        if message.message == WM_TIMER && message.hwnd.0.is_null() {
            // Health check. Unhooking a hook Windows already removed fails
            // harmlessly; installing again restores the hotkey.
            unsafe {
                let _ = UnhookWindowsHookEx(hook);
            };
            ALT_DOWN.store(false, Ordering::SeqCst);
            ALT_CHORD.store(false, Ordering::SeqCst);
            SWALLOW_VK.store(0, Ordering::SeqCst);
            // The matching release can no longer be recognised, so a deferred
            // stop is dropped rather than fired: firing here would stop and
            // paste a recording while the user still holds the key, possibly
            // mid-chord.
            PENDING_STOP.store(false, Ordering::SeqCst);
            send_replay(Replay::MenuUp);
            match unsafe { install_hook() } {
                Ok(next) => {
                    hook = next;
                    clear_error();
                }
                Err(error) => set_error(format!(
                    "The keyboard hook could not be re-installed: {error}"
                )),
            }
        }
    }
    unsafe {
        let _ = KillTimer(None, HOOK_TIMER_ID);
        let _ = UnhookWindowsHookEx(hook);
    }
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }
    let event = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
    if event.flags.contains(LLKHF_INJECTED) && event.dwExtraInfo == RAY_INJECTED {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }
    let message = wparam.0 as u32;
    let down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
    let up = message == WM_KEYUP || message == WM_SYSKEYUP;
    let vk = event.vkCode;

    if vk == VK_RMENU.0 as u32 {
        if down {
            if ALT_DOWN.swap(true, Ordering::SeqCst) {
                return LRESULT(1); // auto-repeat
            }
            ALT_CHORD.store(false, Ordering::SeqCst);
            SWALLOW_VK.store(0, Ordering::SeqCst);
            if CAPTURING.load(Ordering::SeqCst) {
                // Recording: wait for the release. A chord key that follows
                // cancels the dictation, and no stop is ever sent, so the
                // receiver never starts a stop-and-paste it would finish
                // before reading that Cancel.
                PENDING_STOP.store(true, Ordering::SeqCst);
            } else {
                // Idle: start on the press. Cancel-after-start already works
                // here because the receiver runs the queued Cancel once the
                // (fast) start has finished.
                PENDING_STOP.store(false, Ordering::SeqCst);
                send(HotkeyEvent::Toggle(Instant::now()));
            }
            return LRESULT(1);
        }
        if up {
            let chord = ALT_CHORD.swap(false, Ordering::SeqCst);
            let pending = PENDING_STOP.swap(false, Ordering::SeqCst);
            ALT_DOWN.store(false, Ordering::SeqCst);
            if chord {
                send_replay(Replay::MenuUp);
            } else if commit_deferred_stop(pending, CAPTURING.load(Ordering::SeqCst)) {
                // Timestamp the release, not the press: if the duration limit
                // (or a UI stop) ended the recording while Alt was held, the
                // release falls inside the new processing window and the
                // toggle is dropped as stale instead of starting a new
                // recording.
                send(HotkeyEvent::Toggle(Instant::now()));
            }
            return LRESULT(1);
        }
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }

    // The release of a key we swallowed without replaying (Escape during a
    // held Right Alt) must be swallowed too.
    if up && vk == SWALLOW_VK.load(Ordering::SeqCst) {
        SWALLOW_VK.store(0, Ordering::SeqCst);
        return LRESULT(1);
    }

    // Escape cancels dictation. While Right Alt is held it must not turn into
    // Alt+Esc (which would cycle windows), so swallow the whole edge.
    if down && vk == VK_ESCAPE.0 as u32 && CAPTURING.load(Ordering::SeqCst) {
        if ALT_DOWN.load(Ordering::SeqCst) {
            ALT_CHORD.store(true, Ordering::SeqCst);
            SWALLOW_VK.store(vk, Ordering::SeqCst);
        }
        // The dictation is being cancelled, so a stop deferred by a held
        // Right Alt must not fire when it is released later.
        PENDING_STOP.store(false, Ordering::SeqCst);
        send(HotkeyEvent::Cancel);
        return LRESULT(1);
    }

    if ALT_DOWN.load(Ordering::SeqCst) {
        if ALT_CHORD.load(Ordering::SeqCst) {
            if down || up {
                let key = chord_key(event);
                send_replay(if down {
                    Replay::KeyDown(key)
                } else {
                    Replay::KeyUp(key)
                });
                return LRESULT(1);
            }
        } else if down {
            // First key of a chord. Cancel dictation, then replay the chord
            // with Right Alt down so AltGr/@ and Alt+Tab still work. The
            // deferred stop is dropped: this is a chord, not a bare press.
            ALT_CHORD.store(true, Ordering::SeqCst);
            PENDING_STOP.store(false, Ordering::SeqCst);
            let key = chord_key(event);
            send_replay(Replay::MenuDown);
            send_replay(Replay::KeyDown(key));
            send(HotkeyEvent::Cancel);
            return LRESULT(1);
        }
    }

    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// A stop deferred by a Right Alt press during a recording commits only for a
/// bare release while the dictation is still capturing. Escape, the duration
/// limit, or a UI stop may have ended it during the hold; the release must
/// then not toggle a new recording.
fn commit_deferred_stop(pending: bool, capturing: bool) -> bool {
    pending && capturing
}

fn chord_key(event: &KBDLLHOOKSTRUCT) -> ChordKey {
    ChordKey {
        vk: event.vkCode,
        scan: event.scanCode,
        extended: event.flags.contains(LLKHF_EXTENDED),
    }
}

fn send(event: HotkeyEvent) {
    if let Some(sender) = SENDER.get() {
        let _ = sender.send(event);
    }
}

fn send_replay(replay: Replay) {
    if let Some(sender) = REPLAY.get() {
        let _ = sender.send(replay);
    }
}

/// Owns the injected Right Alt down/up for chord replays. Keeping it on a
/// separate thread means the hook callback only ever does two channel sends.
fn spawn_replay_worker() -> mpsc::Sender<Replay> {
    let (tx, rx) = mpsc::channel();
    let _ = thread::Builder::new()
        .name("ray-chord".into())
        .spawn(move || {
            let mut menu_down = false;
            loop {
                match rx.recv_timeout(Duration::from_millis(1_500)) {
                    Ok(Replay::MenuDown) => {
                        if !menu_down {
                            inject_key(VK_RMENU.0, 0, true, false);
                            menu_down = true;
                        }
                    }
                    Ok(Replay::KeyDown(key)) => {
                        if !menu_down {
                            // Never leave a key arriving without its modifier
                            // (the hook always sends MenuDown first).
                            inject_key(VK_RMENU.0, 0, true, false);
                            menu_down = true;
                        }
                        inject_key(key.vk as u16, key.scan as u16, key.extended, false);
                    }
                    Ok(Replay::KeyUp(key)) => {
                        inject_key(key.vk as u16, key.scan as u16, key.extended, true);
                    }
                    Ok(Replay::MenuUp) => {
                        if menu_down {
                            inject_key(VK_RMENU.0, 0, true, true);
                            menu_down = false;
                        }
                    }
                    // If a release was missed (hook removed mid-chord), do not
                    // leave Alt logically down.
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if menu_down {
                            inject_key(VK_RMENU.0, 0, true, true);
                            menu_down = false;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            if menu_down {
                inject_key(VK_RMENU.0, 0, true, true);
            }
        });
    tx
}

fn inject_key(vk: u16, scan: u16, extended: bool, up: bool) {
    let mut flags = if up {
        KEYEVENTF_KEYUP
    } else {
        KEYBD_EVENT_FLAGS(0)
    };
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: RAY_INJECTED,
            },
        },
    };
    unsafe {
        let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(test)]
mod tests {
    use super::commit_deferred_stop;

    #[test]
    fn bare_press_commits_the_deferred_stop() {
        assert!(commit_deferred_stop(true, true));
    }

    #[test]
    fn stop_is_dropped_when_the_recording_already_ended() {
        // Escape, the duration limit, or the UI ended it during the hold.
        assert!(!commit_deferred_stop(true, false));
    }

    #[test]
    fn release_without_a_pending_stop_does_nothing() {
        // An idle press starts immediately, and a chord clears the pending
        // stop before the release arrives.
        assert!(!commit_deferred_stop(false, true));
        assert!(!commit_deferred_stop(false, false));
    }
}
