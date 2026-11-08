//! Configurable dictation shortcut via a low-level keyboard hook
//! (WH_KEYBOARD_LL).
//!
//! The shortcut has three forms:
//!
//! - **A single modifier** (Right Alt by default, but any of Left/Right Alt,
//!   Ctrl, Shift, or Win). Its press and release are swallowed so Windows and
//!   the focused app never see them (no menu bar, no Start menu). If another
//!   key joins while it is held (AltGr, Alt+Tab, Ctrl+C), the recording is
//!   cancelled and the whole chord is replayed with the modifier down, so
//!   normal shortcuts and AltGr characters behave as usual.
//! - **A single safe key** (F1-F24, Pause, Scroll Lock, Insert, navigation and
//!   media keys). Both edges are swallowed and it toggles directly.
//! - **A modifier combo** (e.g. Ctrl+Shift+Space). Only the trigger key is
//!   swallowed; modifiers pass through. When the combo includes Alt or Win, a
//!   dummy key is injected so releasing the modifier does not open the menu bar
//!   (Alt) or Start (Win), and that modifier's release is replayed from the
//!   replay worker so the dummy is always seen first.
//!
//! A bare Win tap would normally open Start; because the hook swallows both
//! edges of a bare-Win shortcut, Start never sees the tap, so Win is supported
//! as a modifier-only shortcut. Windows still handles Win+L (lock) itself,
//! which no low-level hook can reliably suppress; that is documented in the
//! README.
//!
//! While recording, a shortcut press only *defers* the stop until the key is
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
//! Escape while recording cancels and is swallowed. Escape is never a valid
//! shortcut.
//!
//! Capture mode (Settings -> Shortcut) steals every key edge while it watches
//! for the next valid shortcut, so the webview never sees the keys. A modifier
//! tapped on its own is captured as a modifier shortcut, modifiers + a key as a
//! combo, and a lone safe key as a single-key shortcut. Capture times out after
//! ten seconds and is cancelled by Escape (which is reserved for cancelling
//! dictation).

use std::collections::HashSet;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use tokio::sync::mpsc::UnboundedSender;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, KillTimer, PostThreadMessageW, SetTimer, SetWindowsHookExW,
    UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_EXTENDED, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL,
    WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER,
};

use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, Debug)]
pub enum HotkeyEvent {
    /// `at` lets the pipeline drop presses that arrived while it was still
    /// finishing the previous dictation. For a stop deferred to the shortcut's
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
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

// Virtual-key codes used by the state machine. The `windows` crate names some
// of these, but the shortcut logic deals with both generic and side-specific
// modifier codes, so they are spelled out here.
const VK_BACK: u32 = 0x08;
const VK_TAB: u32 = 0x09;
const VK_RETURN: u32 = 0x0D;
const VK_SHIFT: u32 = 0x10;
const VK_CONTROL: u32 = 0x11;
const VK_MENU: u32 = 0x12;
const VK_PAUSE: u32 = 0x13;
const VK_CAPITAL: u32 = 0x14;
const VK_ESCAPE: u32 = 0x1B;
const VK_SPACE: u32 = 0x20;
const VK_PRIOR: u32 = 0x21;
const VK_NEXT: u32 = 0x22;
const VK_END: u32 = 0x23;
const VK_HOME: u32 = 0x24;
const VK_LEFT: u32 = 0x25;
const VK_UP: u32 = 0x26;
const VK_RIGHT: u32 = 0x27;
const VK_DOWN: u32 = 0x28;
const VK_PRINT: u32 = 0x2C;
const VK_INSERT: u32 = 0x2D;
const VK_DELETE: u32 = 0x2E;
const VK_0: u32 = 0x30;
const VK_9: u32 = 0x39;
const VK_A: u32 = 0x41;
const VK_Z: u32 = 0x5A;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
const VK_NUMPAD0: u32 = 0x60;
const VK_NUMPAD9: u32 = 0x69;
const VK_MULTIPLY: u32 = 0x6A;
const VK_ADD: u32 = 0x6B;
const VK_SUBTRACT: u32 = 0x6D;
const VK_DECIMAL: u32 = 0x6E;
const VK_DIVIDE: u32 = 0x6F;
const VK_F1: u32 = 0x70;
const VK_F24: u32 = 0x87;
const VK_NUMLOCK: u32 = 0x90;
const VK_SCROLL: u32 = 0x91;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;
const VK_VOLUME_MUTE: u32 = 0xAD;
const VK_VOLUME_DOWN: u32 = 0xAE;
const VK_VOLUME_UP: u32 = 0xAF;
const VK_MEDIA_NEXT: u32 = 0xB0;
const VK_MEDIA_PREV: u32 = 0xB1;
const VK_MEDIA_STOP: u32 = 0xB2;
const VK_MEDIA_PLAY_PAUSE: u32 = 0xB3;
const VK_OEM_1: u32 = 0xBA;
const VK_OEM_PLUS: u32 = 0xBB;
const VK_OEM_COMMA: u32 = 0xBC;
const VK_OEM_MINUS: u32 = 0xBD;
const VK_OEM_PERIOD: u32 = 0xBE;
const VK_OEM_2: u32 = 0xBF;
const VK_OEM_3: u32 = 0xC0;
const VK_OEM_4: u32 = 0xDB;
const VK_OEM_5: u32 = 0xDC;
const VK_OEM_6: u32 = 0xDD;
const VK_OEM_7: u32 = 0xDE;
const VK_PACKET: u32 = 0xE7;

/// The dummy key injected when a combo with Alt or Win fires. 0x07 is an
/// undefined virtual key: Windows processes the edge (so Alt/Win is no longer
/// "pressed alone" and the menu/Start does not open) but no app reacts to it.
const VK_DUMMY: u32 = 0x07;

/// A modifier that can be a shortcut on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SingleModifier {
    LeftAlt,
    RightAlt,
    LeftCtrl,
    RightCtrl,
    LeftShift,
    RightShift,
    LeftWin,
    RightWin,
}

impl SingleModifier {
    pub fn vk(self) -> u32 {
        match self {
            SingleModifier::LeftAlt => VK_LMENU,
            SingleModifier::RightAlt => VK_RMENU,
            SingleModifier::LeftCtrl => VK_LCONTROL,
            SingleModifier::RightCtrl => VK_RCONTROL,
            SingleModifier::LeftShift => VK_LSHIFT,
            SingleModifier::RightShift => VK_RSHIFT,
            SingleModifier::LeftWin => VK_LWIN,
            SingleModifier::RightWin => VK_RWIN,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            SingleModifier::LeftAlt => "left_alt",
            SingleModifier::RightAlt => "right_alt",
            SingleModifier::LeftCtrl => "left_ctrl",
            SingleModifier::RightCtrl => "right_ctrl",
            SingleModifier::LeftShift => "left_shift",
            SingleModifier::RightShift => "right_shift",
            SingleModifier::LeftWin => "left_win",
            SingleModifier::RightWin => "right_win",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            SingleModifier::LeftAlt => "Left Alt",
            SingleModifier::RightAlt => "Right Alt",
            SingleModifier::LeftCtrl => "Left Ctrl",
            SingleModifier::RightCtrl => "Right Ctrl",
            SingleModifier::LeftShift => "Left Shift",
            SingleModifier::RightShift => "Right Shift",
            SingleModifier::LeftWin => "Left Win",
            SingleModifier::RightWin => "Right Win",
        }
    }

    fn chord(self) -> ChordModifier {
        match self {
            SingleModifier::LeftAlt | SingleModifier::RightAlt => ChordModifier::Alt,
            SingleModifier::LeftCtrl | SingleModifier::RightCtrl => ChordModifier::Ctrl,
            SingleModifier::LeftShift | SingleModifier::RightShift => ChordModifier::Shift,
            SingleModifier::LeftWin | SingleModifier::RightWin => ChordModifier::Win,
        }
    }
}

/// A logical modifier used inside a combo. Sides are deliberately ignored:
/// "Ctrl + D" matches either Ctrl key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChordModifier {
    Ctrl,
    Shift,
    Alt,
    Win,
}

impl ChordModifier {
    fn bit(self) -> u8 {
        match self {
            ChordModifier::Ctrl => 1,
            ChordModifier::Shift => 2,
            ChordModifier::Alt => 4,
            ChordModifier::Win => 8,
        }
    }

    fn order(self) -> u8 {
        match self {
            ChordModifier::Ctrl => 0,
            ChordModifier::Shift => 1,
            ChordModifier::Alt => 2,
            ChordModifier::Win => 3,
        }
    }

    fn id(self) -> &'static str {
        match self {
            ChordModifier::Ctrl => "ctrl",
            ChordModifier::Shift => "shift",
            ChordModifier::Alt => "alt",
            ChordModifier::Win => "win",
        }
    }

    fn label(self) -> &'static str {
        match self {
            ChordModifier::Ctrl => "Ctrl",
            ChordModifier::Shift => "Shift",
            ChordModifier::Alt => "Alt",
            ChordModifier::Win => "Win",
        }
    }

    fn from_id(token: &str) -> Option<Self> {
        match token {
            "ctrl" | "control" | "ctl" => Some(ChordModifier::Ctrl),
            "shift" | "shft" => Some(ChordModifier::Shift),
            "alt" | "menu" => Some(ChordModifier::Alt),
            "win" | "windows" | "meta" | "super" => Some(ChordModifier::Win),
            _ => None,
        }
    }
}

/// The persisted dictation shortcut. Serialized as a compact canonical string
/// (`"right_alt"`, `"f9"`, `"ctrl+shift+space"`) so old settings files keep
/// loading and hand edits stay readable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Hotkey {
    /// A modifier pressed on its own.
    Modifier(SingleModifier),
    /// A single safe key pressed on its own.
    Key(u16),
    /// One or more modifiers plus a non-modifier key.
    Combo {
        modifiers: Vec<ChordModifier>,
        key: u16,
    },
}

impl Default for Hotkey {
    fn default() -> Self {
        Hotkey::Modifier(SingleModifier::RightAlt)
    }
}

impl Hotkey {
    /// Canonical user-facing label: "Right Alt", "F9", "Ctrl + Shift + Space".
    pub fn label(&self) -> String {
        match self {
            Hotkey::Modifier(modifier) => modifier.label().to_string(),
            Hotkey::Key(key) => key_label(*key),
            Hotkey::Combo { modifiers, key } => {
                let mut parts: Vec<String> =
                    modifiers.iter().map(|m| m.label().to_string()).collect();
                parts.push(key_label(*key));
                parts.join(" + ")
            }
        }
    }

    /// Parse a canonical (or friendly) shortcut string. Returns the human
    /// reason when the string names a disallowed shortcut.
    pub fn parse(text: &str) -> Result<Self, String> {
        let parts: Vec<&str> = text
            .split('+')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect();
        if parts.is_empty() {
            return Err("Enter a shortcut.".into());
        }
        if parts.len() == 1 {
            let token = normalize_token(parts[0]);
            if let Some(modifier) = single_modifier_from_id(&token) {
                return Ok(Hotkey::Modifier(modifier));
            }
            let key =
                key_from_id(&token).ok_or_else(|| format!("Unknown shortcut key: {}", parts[0]))?;
            let hotkey = Hotkey::Key(key);
            hotkey.validate()?;
            return Ok(hotkey);
        }
        let mut modifiers: Vec<ChordModifier> = Vec::new();
        for part in &parts[..parts.len() - 1] {
            let token = normalize_token(part);
            let modifier = ChordModifier::from_id(&token)
                .ok_or_else(|| format!("Unknown modifier: {part}"))?;
            if !modifiers.contains(&modifier) {
                modifiers.push(modifier);
            }
        }
        let token = normalize_token(parts[parts.len() - 1]);
        let key = key_from_id(&token)
            .ok_or_else(|| format!("Unknown key: {}", parts[parts.len() - 1]))?;
        let hotkey = Hotkey::Combo { modifiers, key };
        hotkey.validate()?;
        Ok(hotkey.normalized())
    }

    /// Reject anything the hook cannot support. This is the authority for
    /// both capture and `set_hotkey`.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Hotkey::Modifier(_) => Ok(()),
            Hotkey::Key(key) => {
                if is_allowed_single_key(u32::from(*key)) {
                    Ok(())
                } else if u32::from(*key) == VK_ESCAPE {
                    Err("Esc is reserved for cancel.".into())
                } else {
                    Err("That key can't be used on its own. Choose a function key like F9, or add a modifier.".into())
                }
            }
            Hotkey::Combo { modifiers, key } => {
                if modifiers.is_empty() {
                    return Err("A shortcut needs at least one modifier.".into());
                }
                if u32::from(*key) == VK_ESCAPE {
                    return Err("Esc is reserved for cancel.".into());
                }
                if is_modifier_vk(u32::from(*key)) {
                    return Err("Choose a regular key to go with the modifier.".into());
                }
                if !is_valid_combo_key(u32::from(*key)) {
                    return Err("That key can't be part of a shortcut.".into());
                }
                Ok(())
            }
        }
    }

    /// Guarantees a valid, canonical shortcut: invalid values (a hand-edited
    /// settings file, a stale frontend) fall back to Right Alt.
    pub fn normalized(&self) -> Self {
        let candidate = match self {
            Hotkey::Modifier(modifier) => Hotkey::Modifier(*modifier),
            Hotkey::Key(key) => Hotkey::Key(*key),
            Hotkey::Combo { modifiers, key } => {
                let mut deduped = modifiers.clone();
                deduped.sort_by_key(|modifier| modifier.order());
                deduped.dedup();
                Hotkey::Combo {
                    modifiers: deduped,
                    key: *key,
                }
            }
        };
        if candidate.validate().is_ok() {
            candidate
        } else {
            Hotkey::default()
        }
    }

    fn mode(&self) -> HotkeyMode {
        match self {
            Hotkey::Modifier(modifier) => HotkeyMode::Modifier(*modifier),
            Hotkey::Key(key) => HotkeyMode::Key(*key),
            Hotkey::Combo { modifiers, key } => HotkeyMode::Combo(modifiers.clone(), *key),
        }
    }
}

impl std::fmt::Display for Hotkey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Hotkey::Modifier(modifier) => formatter.write_str(modifier.id()),
            Hotkey::Key(key) => formatter.write_str(&key_id(*key)),
            Hotkey::Combo { modifiers, key } => {
                let mut parts: Vec<String> = modifiers.iter().map(|m| m.id().to_string()).collect();
                parts.push(key_id(*key));
                formatter.write_str(&parts.join("+"))
            }
        }
    }
}

impl Serialize for Hotkey {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for Hotkey {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Old and hand-edited settings must never make the whole store
        // unreadable; an unusable value loads as Right Alt.
        let text = String::deserialize(deserializer)?;
        Ok(Hotkey::parse(&text).unwrap_or_default())
    }
}

/// A shortcut plus its display label, as sent to the frontend.
#[derive(Clone, Debug, Serialize)]
pub struct HotkeyView {
    pub hotkey: Hotkey,
    pub label: String,
}

impl HotkeyView {
    pub fn new(hotkey: Hotkey) -> Self {
        let label = hotkey.label();
        Self { hotkey, label }
    }
}

enum HotkeyMode {
    Modifier(SingleModifier),
    Key(u16),
    Combo(Vec<ChordModifier>, u16),
}

fn normalize_token(token: &str) -> String {
    token.trim().to_ascii_lowercase().replace([' ', '-'], "_")
}

fn single_modifier_from_id(token: &str) -> Option<SingleModifier> {
    match token {
        "left_alt" | "lalt" | "alt_left" => Some(SingleModifier::LeftAlt),
        "right_alt" | "ralt" | "alt_right" | "altgr" => Some(SingleModifier::RightAlt),
        "left_ctrl" | "left_control" | "lctrl" | "lcontrol" => Some(SingleModifier::LeftCtrl),
        "right_ctrl" | "right_control" | "rctrl" | "rcontrol" => Some(SingleModifier::RightCtrl),
        "left_shift" | "lshift" => Some(SingleModifier::LeftShift),
        "right_shift" | "rshift" => Some(SingleModifier::RightShift),
        "left_win" | "left_windows" | "lwin" => Some(SingleModifier::LeftWin),
        "right_win" | "right_windows" | "rwin" => Some(SingleModifier::RightWin),
        _ => None,
    }
}

fn key_from_id(token: &str) -> Option<u16> {
    let bytes = token.as_bytes();
    if bytes.len() == 1 {
        match bytes[0] {
            b'a'..=b'z' => return Some((VK_A + u32::from(bytes[0] - b'a')) as u16),
            b'0'..=b'9' => return Some((VK_0 + u32::from(bytes[0] - b'0')) as u16),
            _ => {}
        }
    }
    if let Some(number) = token.strip_prefix('f') {
        if let Ok(index) = number.parse::<u32>() {
            if (1..=24).contains(&index) {
                return Some((VK_F1 + index - 1) as u16);
            }
        }
    }
    if let Some(hex) = token.strip_prefix("vk_0x") {
        if let Ok(code) = u32::from_str_radix(hex, 16) {
            return u16::try_from(code).ok();
        }
    }
    if let Some(hex) = token.strip_prefix("vk_") {
        if let Ok(code) = u32::from_str_radix(hex, 16) {
            return u16::try_from(code).ok();
        }
    }
    let named = match token {
        "backspace" => VK_BACK,
        "tab" => VK_TAB,
        "enter" | "return" => VK_RETURN,
        "pause" => VK_PAUSE,
        "caps_lock" | "capslock" => VK_CAPITAL,
        "esc" | "escape" => VK_ESCAPE,
        "space" | "spacebar" => VK_SPACE,
        "page_up" | "pageup" | "pgup" => VK_PRIOR,
        "page_down" | "pagedown" | "pgdn" => VK_NEXT,
        "end" => VK_END,
        "home" => VK_HOME,
        "left" | "arrow_left" => VK_LEFT,
        "up" | "arrow_up" => VK_UP,
        "right" | "arrow_right" => VK_RIGHT,
        "down" | "arrow_down" => VK_DOWN,
        "print_screen" | "printscreen" | "prtsc" => VK_PRINT,
        "insert" | "ins" => VK_INSERT,
        "delete" | "del" => VK_DELETE,
        "numpad0" => VK_NUMPAD0,
        "numpad1" => VK_NUMPAD0 + 1,
        "numpad2" => VK_NUMPAD0 + 2,
        "numpad3" => VK_NUMPAD0 + 3,
        "numpad4" => VK_NUMPAD0 + 4,
        "numpad5" => VK_NUMPAD0 + 5,
        "numpad6" => VK_NUMPAD0 + 6,
        "numpad7" => VK_NUMPAD0 + 7,
        "numpad8" => VK_NUMPAD0 + 8,
        "numpad9" => VK_NUMPAD0 + 9,
        "numpad_multiply" | "numpad_star" => VK_MULTIPLY,
        "numpad_add" | "numpad_plus" => VK_ADD,
        "numpad_subtract" | "numpad_minus" => VK_SUBTRACT,
        "numpad_decimal" | "numpad_period" => VK_DECIMAL,
        "numpad_divide" | "numpad_slash" => VK_DIVIDE,
        "num_lock" | "numlock" => VK_NUMLOCK,
        "scroll_lock" | "scrolllock" => VK_SCROLL,
        "semicolon" => VK_OEM_1,
        "equals" | "plus" => VK_OEM_PLUS,
        "comma" => VK_OEM_COMMA,
        "minus" => VK_OEM_MINUS,
        "period" | "dot" => VK_OEM_PERIOD,
        "slash" => VK_OEM_2,
        "backtick" | "grave" => VK_OEM_3,
        "left_bracket" | "bracket_left" => VK_OEM_4,
        "backslash" => VK_OEM_5,
        "right_bracket" | "bracket_right" => VK_OEM_6,
        "quote" | "apostrophe" => VK_OEM_7,
        "volume_mute" | "mute" => VK_VOLUME_MUTE,
        "volume_down" => VK_VOLUME_DOWN,
        "volume_up" => VK_VOLUME_UP,
        "media_next" => VK_MEDIA_NEXT,
        "media_previous" | "media_prev" => VK_MEDIA_PREV,
        "media_stop" => VK_MEDIA_STOP,
        "media_play_pause" | "media_play" => VK_MEDIA_PLAY_PAUSE,
        _ => return None,
    };
    Some(named as u16)
}

fn key_id(key: u16) -> String {
    let code = u32::from(key);
    if (VK_A..=VK_Z).contains(&code) {
        return char::from(b'a' + (code - VK_A) as u8).to_string();
    }
    if (VK_0..=VK_9).contains(&code) {
        return char::from(b'0' + (code - VK_0) as u8).to_string();
    }
    if (VK_F1..=VK_F24).contains(&code) {
        return format!("f{}", code - VK_F1 + 1);
    }
    if (VK_NUMPAD0..=VK_NUMPAD9).contains(&code) {
        return format!("numpad{}", code - VK_NUMPAD0);
    }
    let named = match code {
        VK_BACK => "backspace",
        VK_TAB => "tab",
        VK_RETURN => "enter",
        VK_PAUSE => "pause",
        VK_CAPITAL => "caps_lock",
        VK_ESCAPE => "esc",
        VK_SPACE => "space",
        VK_PRIOR => "page_up",
        VK_NEXT => "page_down",
        VK_END => "end",
        VK_HOME => "home",
        VK_LEFT => "left",
        VK_UP => "up",
        VK_RIGHT => "right",
        VK_DOWN => "down",
        VK_PRINT => "print_screen",
        VK_INSERT => "insert",
        VK_DELETE => "delete",
        VK_MULTIPLY => "numpad_multiply",
        VK_ADD => "numpad_add",
        VK_SUBTRACT => "numpad_subtract",
        VK_DECIMAL => "numpad_decimal",
        VK_DIVIDE => "numpad_divide",
        VK_NUMLOCK => "num_lock",
        VK_SCROLL => "scroll_lock",
        VK_OEM_1 => "semicolon",
        VK_OEM_PLUS => "equals",
        VK_OEM_COMMA => "comma",
        VK_OEM_MINUS => "minus",
        VK_OEM_PERIOD => "period",
        VK_OEM_2 => "slash",
        VK_OEM_3 => "backtick",
        VK_OEM_4 => "left_bracket",
        VK_OEM_5 => "backslash",
        VK_OEM_6 => "right_bracket",
        VK_OEM_7 => "quote",
        VK_VOLUME_MUTE => "volume_mute",
        VK_VOLUME_DOWN => "volume_down",
        VK_VOLUME_UP => "volume_up",
        VK_MEDIA_NEXT => "media_next",
        VK_MEDIA_PREV => "media_previous",
        VK_MEDIA_STOP => "media_stop",
        VK_MEDIA_PLAY_PAUSE => "media_play_pause",
        _ => return format!("vk_0x{code:02x}"),
    };
    named.to_string()
}

fn key_label(key: u16) -> String {
    let code = u32::from(key);
    if (VK_A..=VK_Z).contains(&code) {
        return char::from(b'A' + (code - VK_A) as u8).to_string();
    }
    if (VK_0..=VK_9).contains(&code) {
        return char::from(b'0' + (code - VK_0) as u8).to_string();
    }
    if (VK_F1..=VK_F24).contains(&code) {
        return format!("F{}", code - VK_F1 + 1);
    }
    if (VK_NUMPAD0..=VK_NUMPAD9).contains(&code) {
        return format!("Numpad {}", code - VK_NUMPAD0);
    }
    let named = match code {
        VK_BACK => "Backspace",
        VK_TAB => "Tab",
        VK_RETURN => "Enter",
        VK_PAUSE => "Pause",
        VK_CAPITAL => "Caps Lock",
        VK_ESCAPE => "Esc",
        VK_SPACE => "Space",
        VK_PRIOR => "Page Up",
        VK_NEXT => "Page Down",
        VK_END => "End",
        VK_HOME => "Home",
        VK_LEFT => "Left",
        VK_UP => "Up",
        VK_RIGHT => "Right",
        VK_DOWN => "Down",
        VK_PRINT => "Print Screen",
        VK_INSERT => "Insert",
        VK_DELETE => "Delete",
        VK_MULTIPLY => "Numpad *",
        VK_ADD => "Numpad +",
        VK_SUBTRACT => "Numpad -",
        VK_DECIMAL => "Numpad .",
        VK_DIVIDE => "Numpad /",
        VK_NUMLOCK => "Num Lock",
        VK_SCROLL => "Scroll Lock",
        VK_OEM_1 => ";",
        VK_OEM_PLUS => "=",
        VK_OEM_COMMA => ",",
        VK_OEM_MINUS => "-",
        VK_OEM_PERIOD => ".",
        VK_OEM_2 => "/",
        VK_OEM_3 => "`",
        VK_OEM_4 => "[",
        VK_OEM_5 => "\\",
        VK_OEM_6 => "]",
        VK_OEM_7 => "'",
        VK_VOLUME_MUTE => "Mute",
        VK_VOLUME_DOWN => "Volume Down",
        VK_VOLUME_UP => "Volume Up",
        VK_MEDIA_NEXT => "Next Track",
        VK_MEDIA_PREV => "Previous Track",
        VK_MEDIA_STOP => "Stop",
        VK_MEDIA_PLAY_PAUSE => "Play/Pause",
        _ => return format!("Key 0x{code:02X}"),
    };
    named.to_string()
}

/// Keys that are safe to steal on their own: nothing types them, and none is
/// an editing or window-management key that would strand the user.
fn is_allowed_single_key(vk: u32) -> bool {
    (VK_F1..=VK_F24).contains(&vk)
        || matches!(
            vk,
            VK_PAUSE
                | VK_SCROLL
                | VK_INSERT
                | VK_HOME
                | VK_END
                | VK_PRIOR
                | VK_NEXT
                | VK_VOLUME_MUTE
                | VK_VOLUME_DOWN
                | VK_VOLUME_UP
                | VK_MEDIA_NEXT
                | VK_MEDIA_PREV
                | VK_MEDIA_STOP
                | VK_MEDIA_PLAY_PAUSE
        )
}

fn is_letter_or_digit(vk: u32) -> bool {
    (VK_A..=VK_Z).contains(&vk)
        || (VK_0..=VK_9).contains(&vk)
        || (VK_NUMPAD0..=VK_NUMPAD9).contains(&vk)
}

/// A combo trigger can be any physical, non-modifier key except Escape.
fn is_valid_combo_key(vk: u32) -> bool {
    (0x08..=0xFE).contains(&vk) && vk != VK_ESCAPE && vk != VK_PACKET && !is_modifier_vk(vk)
}

fn logical_modifier(vk: u32) -> Option<ChordModifier> {
    match vk {
        VK_SHIFT | VK_LSHIFT | VK_RSHIFT => Some(ChordModifier::Shift),
        VK_CONTROL | VK_LCONTROL | VK_RCONTROL => Some(ChordModifier::Ctrl),
        VK_MENU | VK_LMENU | VK_RMENU => Some(ChordModifier::Alt),
        VK_LWIN | VK_RWIN => Some(ChordModifier::Win),
        _ => None,
    }
}

fn is_modifier_vk(vk: u32) -> bool {
    logical_modifier(vk).is_some()
}

fn single_modifier_from_vk(vk: u32) -> Option<SingleModifier> {
    match vk {
        VK_LMENU => Some(SingleModifier::LeftAlt),
        VK_RMENU => Some(SingleModifier::RightAlt),
        VK_LCONTROL => Some(SingleModifier::LeftCtrl),
        VK_RCONTROL => Some(SingleModifier::RightCtrl),
        VK_LSHIFT => Some(SingleModifier::LeftShift),
        VK_RSHIFT => Some(SingleModifier::RightShift),
        VK_LWIN => Some(SingleModifier::LeftWin),
        VK_RWIN => Some(SingleModifier::RightWin),
        _ => None,
    }
}

fn modifier_mask(modifiers: &[ChordModifier]) -> u8 {
    modifiers
        .iter()
        .fold(0, |mask, modifier| mask | modifier.bit())
}

/// A physical key edge, kept so replays can reproduce scan code and the
/// extended flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct KeyRef {
    vk: u32,
    scan: u32,
    extended: bool,
}

#[derive(Clone, Copy, Debug)]
struct KeyInput {
    vk: u32,
    down: bool,
    scan: u32,
    extended: bool,
    /// Ray's own injected input (paste, replays). The hook filters these before
    /// the state machine; the flag is still part of the input so the pure
    /// state machine can be tested with injected events too.
    ray_injected: bool,
}

impl KeyInput {
    fn key_ref(self) -> KeyRef {
        KeyRef {
            vk: self.vk,
            scan: self.scan,
            extended: self.extended,
        }
    }
}

/// One repair the hook must perform for a key edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Replay {
    /// Inject the swallowed shortcut modifier (chord recovery).
    ChordDown(KeyRef),
    /// Release the injected shortcut modifier.
    ChordUp,
    KeyDown(KeyRef),
    KeyUp(KeyRef),
    /// The dummy key that stops Alt/Win from opening the menu bar or Start.
    Dummy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Action {
    Pass,
    Swallow,
    Toggle,
    Cancel,
    Replay(Replay),
    Captured { hotkey: Hotkey, label: String },
    CaptureError(String),
}

#[derive(Clone, Copy)]
struct DownModifier {
    logical: ChordModifier,
    key: KeyRef,
}

struct Capture {
    id: u64,
    deadline: Instant,
    /// Physical modifier keys currently down (capture swallows their edges).
    modifiers_down: Vec<DownModifier>,
    /// Distinct modifiers pressed during this capture, in press order.
    modifiers_seen: Vec<SingleModifier>,
}

/// The entire hook decision logic. Pure except for the clock: unit tests feed
/// key edges and assert the actions without Win32 or a real keyboard.
struct HookState {
    hotkey: Hotkey,
    recording: bool,
    // A modifier shortcut is held (its press was swallowed).
    prime: Option<KeyRef>,
    // Another key joined the held modifier shortcut; the chord is replayed.
    prime_chord: bool,
    // The shortcut press happened while recording, so the stop waits for the
    // release (a chord key cancels instead).
    pending_stop: bool,
    // A single-key shortcut is held (auto-repeat guard).
    single_down: bool,
    // Physical modifiers currently down, for combo matching.
    modifiers_down: Vec<DownModifier>,
    // A combo trigger was swallowed; its release is swallowed too.
    trigger_down: bool,
    // Alt/Win releases that were taken over so the dummy key is seen first.
    deferred_ups: Vec<KeyRef>,
    // Releases that must be swallowed without further handling.
    swallow_releases: HashSet<u32>,
    esc_down: bool,
    capture: Option<Capture>,
    capture_counter: u64,
}

impl Default for HookState {
    fn default() -> Self {
        Self::new(Hotkey::default())
    }
}

impl HookState {
    fn new(hotkey: Hotkey) -> Self {
        Self {
            hotkey: hotkey.normalized(),
            recording: false,
            prime: None,
            prime_chord: false,
            pending_stop: false,
            single_down: false,
            modifiers_down: Vec::new(),
            trigger_down: false,
            deferred_ups: Vec::new(),
            swallow_releases: HashSet::new(),
            esc_down: false,
            capture: None,
            capture_counter: 0,
        }
    }

    /// Apply a new shortcut without restarting the hook. A modifier that is
    /// held right now had its press swallowed; its release is swallowed too so
    /// the focused app never sees a lone key-up.
    fn apply_hotkey(&mut self, hotkey: Hotkey) {
        if let Some(prime) = self.prime.take() {
            self.swallow_releases.insert(prime.vk);
        }
        self.prime_chord = false;
        self.pending_stop = false;
        self.single_down = false;
        self.trigger_down = false;
        self.deferred_ups.clear();
        self.finish_capture(&[]);
        self.hotkey = hotkey.normalized();
    }

    /// Called after the hook is (re)installed: any in-flight chord state is
    /// lost, so drop it rather than let a stale release toggle a recording.
    fn reset_transient(&mut self) {
        if let Some(prime) = self.prime.take() {
            self.swallow_releases.insert(prime.vk);
        }
        self.prime_chord = false;
        self.pending_stop = false;
        self.single_down = false;
        self.trigger_down = false;
        self.deferred_ups.clear();
        if let Some(capture) = self.capture.as_mut() {
            let held: Vec<u32> = capture
                .modifiers_down
                .iter()
                .map(|entry| entry.key.vk)
                .collect();
            capture.modifiers_down.clear();
            capture.modifiers_seen.clear();
            for vk in held {
                self.swallow_releases.insert(vk);
            }
        }
    }

    fn begin_capture(&mut self) -> (u64, Instant) {
        if let Some(prime) = self.prime.take() {
            self.swallow_releases.insert(prime.vk);
        }
        self.prime_chord = false;
        self.pending_stop = false;
        self.single_down = false;
        self.trigger_down = false;
        self.deferred_ups.clear();
        self.capture_counter += 1;
        let deadline = Instant::now() + CAPTURE_TIMEOUT;
        self.capture = Some(Capture {
            id: self.capture_counter,
            deadline,
            modifiers_down: Vec::new(),
            modifiers_seen: Vec::new(),
        });
        (self.capture_counter, deadline)
    }

    /// End capture and swallow the releases of every key capture took over.
    fn finish_capture(&mut self, extra_vks: &[u32]) {
        if let Some(capture) = self.capture.take() {
            for entry in capture.modifiers_down {
                self.swallow_releases.insert(entry.key.vk);
            }
        }
        for vk in extra_vks {
            self.swallow_releases.insert(*vk);
        }
    }

    fn timeout_capture(&mut self, id: u64, now: Instant) -> Vec<Action> {
        let expired = matches!(
            &self.capture,
            Some(capture) if capture.id == id && now >= capture.deadline
        );
        if !expired {
            return Vec::new();
        }
        self.finish_capture(&[]);
        vec![Action::CaptureError(
            "No shortcut detected. Try again.".into(),
        )]
    }

    /// Forget every trace of a key whose release was consumed elsewhere.
    fn forget_key(&mut self, vk: u32) {
        self.modifiers_down.retain(|entry| entry.key.vk != vk);
        self.deferred_ups.retain(|entry| entry.vk != vk);
    }

    fn current_modifier_mask(&self) -> u8 {
        self.modifiers_down
            .iter()
            .fold(0, |mask, entry| mask | entry.logical.bit())
    }

    /// Track physical modifiers for combo matching. A deferred Alt/Win release
    /// (see `on_combo_key`) is reported so the caller can replay it.
    fn track_modifier(&mut self, key: &KeyInput) -> Option<Action> {
        let logical = logical_modifier(key.vk)?;
        if key.down {
            if !self
                .modifiers_down
                .iter()
                .any(|entry| entry.key.vk == key.vk)
            {
                self.modifiers_down.push(DownModifier {
                    logical,
                    key: key.key_ref(),
                });
            }
            None
        } else {
            self.modifiers_down.retain(|entry| entry.key.vk != key.vk);
            let index = self
                .deferred_ups
                .iter()
                .position(|entry| entry.vk == key.vk)?;
            let released = self.deferred_ups.remove(index);
            Some(Action::Replay(Replay::KeyUp(released)))
        }
    }

    fn on_key(&mut self, key: KeyInput) -> Vec<Action> {
        if key.ray_injected {
            return vec![Action::Pass];
        }
        if self.capture.is_some() {
            return self.on_capture_key(key);
        }
        // A release already accounted for: Escape after cancelling, keys that
        // were held when capture ended, a shortcut changed mid-hold.
        if !key.down && self.swallow_releases.remove(&key.vk) {
            self.forget_key(key.vk);
            if key.vk == VK_ESCAPE {
                self.esc_down = false;
            }
            return vec![Action::Swallow];
        }
        // Escape cancels dictation. While a modifier shortcut is held it must
        // not become Alt+Esc (window cycling), so the edge is swallowed.
        if key.down && key.vk == VK_ESCAPE && self.recording {
            if self.prime.is_some() {
                self.prime_chord = true;
            }
            self.pending_stop = false;
            self.swallow_releases.insert(key.vk);
            if self.esc_down {
                return vec![Action::Swallow];
            }
            self.esc_down = true;
            return vec![Action::Cancel, Action::Swallow];
        }
        if let Some(action) = self.track_modifier(&key) {
            return vec![action, Action::Swallow];
        }
        match self.hotkey.mode() {
            HotkeyMode::Modifier(modifier) => self.on_modifier_key(key, modifier),
            HotkeyMode::Key(trigger) => self.on_single_key(key, trigger),
            HotkeyMode::Combo(modifiers, trigger) => self.on_combo_key(key, &modifiers, trigger),
        }
    }

    fn on_modifier_key(&mut self, key: KeyInput, modifier: SingleModifier) -> Vec<Action> {
        if key.vk != modifier.vk() {
            let Some(prime) = self.prime else {
                return vec![Action::Pass];
            };
            if key.down && !self.prime_chord {
                // First key of a chord: replay the swallowed modifier and the
                // key, then cancel. AltGr characters and Alt+Tab keep working.
                self.prime_chord = true;
                self.pending_stop = false;
                return vec![
                    Action::Replay(Replay::ChordDown(prime)),
                    Action::Replay(Replay::KeyDown(key.key_ref())),
                    Action::Cancel,
                    Action::Swallow,
                ];
            }
            if self.prime_chord {
                let replay = if key.down {
                    Replay::KeyDown(key.key_ref())
                } else {
                    Replay::KeyUp(key.key_ref())
                };
                return vec![Action::Replay(replay), Action::Swallow];
            }
            return vec![Action::Pass];
        }

        if key.down {
            if self.prime.is_some() {
                return vec![Action::Swallow]; // auto-repeat
            }
            self.prime = Some(key.key_ref());
            self.prime_chord = false;
            self.swallow_releases.remove(&key.vk);
            if self.recording {
                // Wait for the release: a chord key that follows cancels the
                // recording, and no stop is ever sent, so the receiver never
                // starts a stop-and-paste it would finish before reading that
                // Cancel.
                self.pending_stop = true;
                vec![Action::Swallow]
            } else {
                // Idle: start on the press. Cancel-after-start already works
                // because the receiver runs the queued Cancel once the (fast)
                // start has finished.
                self.pending_stop = false;
                vec![Action::Toggle, Action::Swallow]
            }
        } else {
            let chord = std::mem::take(&mut self.prime_chord);
            let pending = std::mem::take(&mut self.pending_stop);
            self.prime = None;
            if chord {
                vec![Action::Replay(Replay::ChordUp), Action::Swallow]
            } else if pending && self.recording {
                // Timestamp the release, not the press: if the duration limit
                // (or a UI stop) ended the recording while the key was held,
                // the release falls inside the processing window and the
                // toggle is dropped as stale.
                vec![Action::Toggle, Action::Swallow]
            } else {
                vec![Action::Swallow]
            }
        }
    }

    fn on_single_key(&mut self, key: KeyInput, trigger: u16) -> Vec<Action> {
        if key.vk != u32::from(trigger) {
            return vec![Action::Pass];
        }
        if key.down {
            if self.single_down {
                return vec![Action::Swallow]; // auto-repeat
            }
            self.single_down = true;
            vec![Action::Toggle, Action::Swallow]
        } else {
            self.single_down = false;
            vec![Action::Swallow]
        }
    }

    fn on_combo_key(
        &mut self,
        key: KeyInput,
        modifiers: &[ChordModifier],
        trigger: u16,
    ) -> Vec<Action> {
        if key.vk != u32::from(trigger) {
            return vec![Action::Pass];
        }
        if !key.down {
            if self.trigger_down {
                self.trigger_down = false;
                return vec![Action::Swallow];
            }
            return vec![Action::Pass];
        }
        if self.trigger_down {
            return vec![Action::Swallow]; // auto-repeat
        }
        // Exact modifier set: Ctrl+Shift+Space must not fire Ctrl+Space.
        if self.current_modifier_mask() != modifier_mask(modifiers) {
            return vec![Action::Pass];
        }
        self.trigger_down = true;
        let mut actions = Vec::new();
        if modifiers
            .iter()
            .any(|modifier| matches!(modifier, ChordModifier::Alt | ChordModifier::Win))
        {
            // The modifier's press reached the app; inject a dummy key so the
            // release does not open the menu bar (Alt) or Start (Win), then
            // replay the release from the worker so the dummy is always seen
            // first.
            actions.push(Action::Replay(Replay::Dummy));
            let deferred: Vec<KeyRef> = self
                .modifiers_down
                .iter()
                .filter(|entry| matches!(entry.logical, ChordModifier::Alt | ChordModifier::Win))
                .map(|entry| entry.key)
                .collect();
            for key in deferred {
                // Triggering again before the release must not queue it twice.
                if !self.deferred_ups.iter().any(|entry| entry.vk == key.vk) {
                    self.deferred_ups.push(key);
                }
            }
        }
        actions.push(Action::Toggle);
        actions.push(Action::Swallow);
        actions
    }

    fn on_capture_key(&mut self, key: KeyInput) -> Vec<Action> {
        // A key that was already held when capture began has its release
        // consumed here; drop the stale "swallow this release later" marker so
        // the next real press behaves normally.
        if !key.down {
            self.swallow_releases.remove(&key.vk);
            self.forget_key(key.vk);
        }
        if key.vk == VK_ESCAPE {
            if key.down {
                self.finish_capture(&[key.vk]);
                return vec![Action::CaptureError("Esc is reserved for cancel.".into())];
            }
            return vec![Action::Swallow];
        }

        if let Some(modifier) = single_modifier_from_vk(key.vk) {
            let Some(capture) = self.capture.as_mut() else {
                return vec![Action::Swallow];
            };
            if key.down {
                if !capture
                    .modifiers_down
                    .iter()
                    .any(|entry| entry.key.vk == key.vk)
                {
                    capture.modifiers_down.push(DownModifier {
                        logical: modifier.chord(),
                        key: key.key_ref(),
                    });
                    if !capture.modifiers_seen.contains(&modifier) {
                        capture.modifiers_seen.push(modifier);
                    }
                }
                return vec![Action::Swallow];
            }
            capture
                .modifiers_down
                .retain(|entry| entry.key.vk != key.vk);
            let tap_finished =
                capture.modifiers_down.is_empty() && !capture.modifiers_seen.is_empty();
            if !tap_finished {
                return vec![Action::Swallow];
            }
            let seen = capture.modifiers_seen.clone();
            self.finish_capture(&[]);
            if seen.len() == 1 {
                let hotkey = Hotkey::Modifier(seen[0]);
                let label = hotkey.label();
                return vec![Action::Captured { hotkey, label }];
            }
            return vec![Action::CaptureError(
                "Add a key to the shortcut, like Ctrl + Shift + Space.".into(),
            )];
        }

        if is_modifier_vk(key.vk) {
            // A generic modifier code (no side); it cannot be captured alone.
            return vec![Action::Swallow];
        }

        if !key.down {
            return vec![Action::Swallow];
        }

        let modifiers: Vec<ChordModifier> = {
            let capture = self.capture.as_ref().expect("capture checked above");
            let mut modifiers = Vec::new();
            for entry in &capture.modifiers_down {
                if !modifiers.contains(&entry.logical) {
                    modifiers.push(entry.logical);
                }
            }
            modifiers
        };

        if modifiers.is_empty() {
            if is_allowed_single_key(key.vk) {
                let hotkey = Hotkey::Key(key.vk as u16);
                self.finish_capture(&[key.vk]);
                let label = hotkey.label();
                return vec![Action::Captured { hotkey, label }];
            }
            self.finish_capture(&[key.vk]);
            let message = if is_letter_or_digit(key.vk) {
                "Letters and numbers need a modifier. Try Ctrl + D, or a function key like F9."
            } else {
                "That key can't be used on its own. Try a function key like F9, or add a modifier."
            };
            return vec![Action::CaptureError(message.into())];
        }

        let hotkey = Hotkey::Combo {
            modifiers,
            key: key.vk as u16,
        };
        if let Err(message) = hotkey.validate() {
            self.finish_capture(&[key.vk]);
            return vec![Action::CaptureError(message)];
        }
        let hotkey = hotkey.normalized();
        self.finish_capture(&[key.vk]);
        let label = hotkey.label();
        vec![Action::Captured { hotkey, label }]
    }
}

static SENDER: OnceLock<UnboundedSender<HotkeyEvent>> = OnceLock::new();
static REPLAY: OnceLock<mpsc::Sender<Replay>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static STATE: OnceLock<Mutex<HookState>> = OnceLock::new();
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
static HOOK_JOIN: Mutex<Option<thread::JoinHandle<()>>> = Mutex::new(None);
static INSTALL_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// Marks the synthetic keys Ray itself sends (Ctrl+V for paste, chord and
/// dummy replays) so the hook ignores them. Other tools' injected keys are
/// still handled, which also makes the shortcut testable with SendInput.
pub const RAY_INJECTED: usize = 0x5241_5901;

fn state() -> &'static Mutex<HookState> {
    STATE.get_or_init(|| Mutex::new(HookState::default()))
}

fn with_state<R>(f: impl FnOnce(&mut HookState) -> R) -> R {
    let mut state = state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut state)
}

/// Install the hook with the shortcut saved in settings. The app handle is
/// used to emit `hotkey-captured`, `hotkey-capture-error` and `hotkey-changed`
/// to the main window.
pub fn install(
    sender: UnboundedSender<HotkeyEvent>,
    hotkey: Hotkey,
    app: AppHandle,
) -> Result<(), String> {
    SENDER.set(sender).ok();
    let _ = APP.set(app);
    with_state(|state| state.apply_hotkey(hotkey));
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

/// Apply a shortcut change without reinstalling or restarting the hook.
pub fn set_hotkey(hotkey: Hotkey) {
    with_state(|state| state.apply_hotkey(hotkey));
}

/// Start watching for the next shortcut. Every key edge is swallowed until a
/// shortcut is captured, Escape is pressed, or the ten-second timeout fires.
pub fn start_capture() -> Result<(), String> {
    if SENDER.get().is_none() || HOOK_THREAD.load(Ordering::SeqCst) == 0 {
        return Err("The keyboard hook is not running.".into());
    }
    let (id, deadline) = with_state(HookState::begin_capture);
    thread::Builder::new()
        .name("ray-capture".into())
        .spawn(move || {
            let now = Instant::now();
            if deadline > now {
                thread::sleep(deadline - now);
            }
            let actions = with_state(|state| state.timeout_capture(id, Instant::now()));
            if !actions.is_empty() {
                dispatch(actions);
            }
        })
        .map_err(|error| format!("Could not start the shortcut capture: {error}"))?;
    Ok(())
}

/// Stop watching (the UI's Cancel button). Keys that are still down stay
/// swallowed so the webview never receives a lone key-up.
pub fn cancel_capture() {
    with_state(|state| state.finish_capture(&[]));
}

/// Set from the pipeline so Escape is only consumed while recording.
pub fn set_capturing(capturing: bool) {
    with_state(|state| state.recording = capturing);
}

fn start_thread() -> Result<(), String> {
    // The replay worker is shared by every hook installation.
    let _ = REPLAY.get_or_init(spawn_replay_worker);

    stop_thread();
    // The old hook may have been removed mid-chord; do not let a stale key-up
    // toggle a recording once the new hook is live.
    with_state(HookState::reset_transient);
    send_replay(Replay::ChordUp);

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

fn emit_event<T: Serialize + Clone>(event: &str, payload: &T) {
    if let Some(app) = APP.get() {
        let _ = app.emit_to("main", event, payload.clone());
    }
}

fn dispatch(actions: Vec<Action>) -> bool {
    let mut swallow = false;
    for action in actions {
        match action {
            Action::Pass => {}
            Action::Swallow => swallow = true,
            Action::Toggle => {
                send(HotkeyEvent::Toggle(Instant::now()));
                swallow = true;
            }
            Action::Cancel => {
                send(HotkeyEvent::Cancel);
                swallow = true;
            }
            Action::Replay(replay) => {
                send_replay(replay);
                swallow = true;
            }
            Action::Captured { hotkey, label } => {
                emit_event("hotkey-captured", &HotkeyView { hotkey, label });
                swallow = true;
            }
            Action::CaptureError(message) => {
                emit_event(
                    "hotkey-capture-error",
                    &serde_json::json!({ "message": message }),
                );
                swallow = true;
            }
        }
    }
    swallow
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
            // harmlessly; installing again restores the shortcut.
            with_state(HookState::reset_transient);
            send_replay(Replay::ChordUp);
            unsafe {
                let _ = UnhookWindowsHookEx(hook);
            }
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
    if !down && !up {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }
    let input = KeyInput {
        vk: event.vkCode,
        down,
        scan: event.scanCode,
        extended: event.flags.contains(LLKHF_EXTENDED),
        ray_injected: false,
    };
    let actions = with_state(|state| state.on_key(input));
    if dispatch(actions) {
        LRESULT(1)
    } else {
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
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

/// Owns the injected shortcut modifier down/up for chord replays and the
/// dummy key. Keeping it on a separate thread means the hook callback only
/// ever does a channel send.
fn spawn_replay_worker() -> mpsc::Sender<Replay> {
    let (tx, rx) = mpsc::channel();
    let _ = thread::Builder::new()
        .name("ray-chord".into())
        .spawn(move || {
            let mut chord: Option<KeyRef> = None;
            loop {
                match rx.recv_timeout(Duration::from_millis(1_500)) {
                    Ok(Replay::ChordDown(key)) => {
                        if chord.is_none() {
                            inject_key(key, false);
                            chord = Some(key);
                        }
                    }
                    Ok(Replay::ChordUp) => {
                        if let Some(key) = chord.take() {
                            inject_key(key, true);
                        }
                    }
                    Ok(Replay::KeyDown(key)) => inject_key(key, false),
                    Ok(Replay::KeyUp(key)) => inject_key(key, true),
                    Ok(Replay::Dummy) => {
                        let dummy = KeyRef {
                            vk: VK_DUMMY,
                            scan: 0,
                            extended: false,
                        };
                        inject_key(dummy, false);
                        inject_key(dummy, true);
                    }
                    // If a release was missed (hook removed mid-chord), do not
                    // leave the modifier logically down.
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if let Some(key) = chord.take() {
                            inject_key(key, true);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            if let Some(key) = chord {
                inject_key(key, true);
            }
        });
    tx
}

fn inject_key(key: KeyRef, up: bool) {
    let mut flags = if up {
        KEYEVENTF_KEYUP
    } else {
        KEYBD_EVENT_FLAGS(0)
    };
    if key.extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(key.vk as u16),
                wScan: key.scan as u16,
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
    use super::*;

    const VK_C: u32 = 0x43;
    const VK_D: u32 = 0x44;

    fn key(vk: u32, down: bool) -> KeyInput {
        KeyInput {
            vk,
            down,
            scan: 0,
            extended: false,
            ray_injected: false,
        }
    }

    fn press(vk: u32) -> KeyInput {
        key(vk, true)
    }

    fn release(vk: u32) -> KeyInput {
        key(vk, false)
    }

    fn toggle() -> Vec<Action> {
        vec![Action::Toggle, Action::Swallow]
    }

    #[test]
    fn labels_are_human_readable() {
        assert_eq!(Hotkey::default().label(), "Right Alt");
        assert_eq!(
            Hotkey::parse("ctrl+shift+space").unwrap().label(),
            "Ctrl + Shift + Space"
        );
        assert_eq!(Hotkey::parse("f9").unwrap().label(), "F9");
        assert_eq!(Hotkey::parse("left_ctrl").unwrap().label(), "Left Ctrl");
        assert_eq!(
            Hotkey::parse("ctrl+alt+r").unwrap().label(),
            "Ctrl + Alt + R"
        );
        assert_eq!(Hotkey::parse("scroll_lock").unwrap().label(), "Scroll Lock");
    }

    #[test]
    fn canonical_strings_round_trip() {
        for text in [
            "right_alt",
            "left_win",
            "f9",
            "scroll_lock",
            "ctrl+shift+space",
            "alt+d",
            "ctrl+alt+r",
        ] {
            let hotkey = Hotkey::parse(text).unwrap_or_else(|error| panic!("{text}: {error}"));
            assert_eq!(hotkey.to_string(), text);
            assert_eq!(Hotkey::parse(&hotkey.to_string()).unwrap(), hotkey);
        }
        // Modifier order is canonical regardless of how it was typed.
        assert_eq!(
            Hotkey::parse("alt+shift+ctrl+d").unwrap().to_string(),
            "ctrl+shift+alt+d"
        );
    }

    #[test]
    fn validation_allows_safe_keys_and_modifiers() {
        for text in [
            "right_alt",
            "left_alt",
            "right_ctrl",
            "left_shift",
            "left_win",
            "right_win",
            "f1",
            "f24",
            "pause",
            "scroll_lock",
            "insert",
            "home",
            "end",
            "page_up",
            "page_down",
        ] {
            assert!(Hotkey::parse(text).is_ok(), "{text} should be allowed");
        }
        for text in ["ctrl+shift+space", "alt+d", "ctrl+alt+r", "win+shift+s"] {
            assert!(Hotkey::parse(text).is_ok(), "{text} should be allowed");
        }
    }

    #[test]
    fn validation_rejects_unsafe_lone_keys() {
        for text in [
            "a",
            "z",
            "0",
            "9",
            "space",
            "enter",
            "tab",
            "backspace",
            "esc",
            "delete",
        ] {
            assert!(Hotkey::parse(text).is_err(), "{text} should be rejected");
        }
        assert!(Hotkey::Key(VK_ESCAPE as u16).validate().is_err());
        // Esc is never a combo trigger either.
        assert!(Hotkey::parse("ctrl+esc").is_err());
        // A modifier is not a trigger key, and a combo needs a modifier.
        assert!(Hotkey::parse("ctrl+shift").is_err());
        assert!(Hotkey::Combo {
            modifiers: Vec::new(),
            key: VK_SPACE as u16,
        }
        .validate()
        .is_err());
        assert!(Hotkey::Combo {
            modifiers: vec![ChordModifier::Ctrl],
            key: VK_SHIFT as u16,
        }
        .validate()
        .is_err());
    }

    #[test]
    fn invalid_settings_values_fall_back_to_right_alt() {
        let hotkey: Hotkey = serde_json::from_str("\"banana\"").unwrap();
        assert_eq!(hotkey, Hotkey::default());
        let hotkey: Hotkey = serde_json::from_str("\"a\"").unwrap();
        assert_eq!(hotkey, Hotkey::default());
        let hotkey: Hotkey = serde_json::from_str("\"esc\"").unwrap();
        assert_eq!(hotkey, Hotkey::default());
    }

    #[test]
    fn modifier_only_press_and_release_toggles_once() {
        let mut state = HookState::default();
        assert_eq!(state.on_key(press(VK_RMENU)), toggle());
        assert_eq!(state.on_key(release(VK_RMENU)), vec![Action::Swallow]);
    }

    #[test]
    fn modifier_auto_repeat_does_not_toggle_again() {
        let mut state = HookState::default();
        assert_eq!(state.on_key(press(VK_RMENU)), toggle());
        assert_eq!(state.on_key(press(VK_RMENU)), vec![Action::Swallow]);
        assert_eq!(state.on_key(release(VK_RMENU)), vec![Action::Swallow]);
    }

    #[test]
    fn press_while_recording_defers_the_stop_until_release() {
        let mut state = HookState {
            recording: true,
            ..HookState::default()
        };
        assert_eq!(state.on_key(press(VK_RMENU)), vec![Action::Swallow]);
        assert_eq!(state.on_key(release(VK_RMENU)), toggle());
    }

    #[test]
    fn stop_is_dropped_when_the_recording_ended_during_the_hold() {
        let mut state = HookState {
            recording: true,
            ..HookState::default()
        };
        state.on_key(press(VK_RMENU));
        state.recording = false;
        assert_eq!(state.on_key(release(VK_RMENU)), vec![Action::Swallow]);
    }

    #[test]
    fn chord_while_recording_cancels_and_replays() {
        let mut state = HookState {
            recording: true,
            ..HookState::default()
        };
        let prime = KeyRef {
            vk: VK_RMENU,
            scan: 0,
            extended: false,
        };
        state.on_key(press(VK_RMENU));
        let chord_down = state.on_key(press(VK_C));
        assert!(chord_down.contains(&Action::Replay(Replay::ChordDown(prime))));
        assert!(chord_down.contains(&Action::Replay(Replay::KeyDown(KeyRef {
            vk: VK_C,
            scan: 0,
            extended: false,
        }))));
        assert!(chord_down.contains(&Action::Cancel));
        assert!(chord_down
            .iter()
            .any(|action| matches!(action, Action::Swallow)));
        assert_eq!(
            state.on_key(release(VK_C)),
            vec![
                Action::Replay(Replay::KeyUp(KeyRef {
                    vk: VK_C,
                    scan: 0,
                    extended: false,
                })),
                Action::Swallow,
            ]
        );
        assert_eq!(
            state.on_key(release(VK_RMENU)),
            vec![Action::Replay(Replay::ChordUp), Action::Swallow]
        );
    }

    #[test]
    fn escape_cancels_while_recording() {
        let mut state = HookState {
            recording: true,
            ..HookState::default()
        };
        let cancel = state.on_key(press(VK_ESCAPE));
        assert!(cancel.contains(&Action::Cancel));
        assert!(cancel
            .iter()
            .any(|action| matches!(action, Action::Swallow)));
        assert_eq!(state.on_key(release(VK_ESCAPE)), vec![Action::Swallow]);
    }

    #[test]
    fn single_key_shortcut_toggles_and_ignores_repeats() {
        let mut state = HookState::new(Hotkey::parse("f9").unwrap());
        let f9 = VK_F1 + 8;
        assert_eq!(state.on_key(press(f9)), toggle());
        assert_eq!(state.on_key(press(f9)), vec![Action::Swallow]);
        assert_eq!(state.on_key(release(f9)), vec![Action::Swallow]);
        assert_eq!(state.on_key(press(VK_A)), vec![Action::Pass]);
    }

    #[test]
    fn combo_requires_the_exact_modifiers_and_swallows_only_the_trigger() {
        let mut state = HookState::new(Hotkey::parse("ctrl+shift+space").unwrap());
        assert_eq!(state.on_key(press(VK_LCONTROL)), vec![Action::Pass]);
        assert_eq!(state.on_key(press(VK_SPACE)), vec![Action::Pass]);
        assert_eq!(state.on_key(press(VK_LSHIFT)), vec![Action::Pass]);
        assert_eq!(state.on_key(press(VK_SPACE)), toggle());
        assert_eq!(state.on_key(press(VK_SPACE)), vec![Action::Swallow]);
        assert_eq!(state.on_key(release(VK_SPACE)), vec![Action::Swallow]);
        assert_eq!(state.on_key(release(VK_LSHIFT)), vec![Action::Pass]);
        assert_eq!(state.on_key(release(VK_LCONTROL)), vec![Action::Pass]);
    }

    #[test]
    fn combo_with_alt_injects_a_dummy_and_replays_the_release() {
        let mut state = HookState::new(Hotkey::parse("alt+d").unwrap());
        let alt_down = KeyInput {
            vk: VK_LMENU,
            down: true,
            scan: 0x38,
            extended: false,
            ray_injected: false,
        };
        assert_eq!(state.on_key(alt_down), vec![Action::Pass]);
        let triggered = state.on_key(press(VK_D));
        assert!(triggered.contains(&Action::Replay(Replay::Dummy)));
        assert!(triggered.contains(&Action::Toggle));
        assert!(triggered
            .iter()
            .any(|action| matches!(action, Action::Swallow)));

        let alt_up = KeyInput {
            vk: VK_LMENU,
            down: false,
            scan: 0x38,
            extended: false,
            ray_injected: false,
        };
        assert_eq!(
            state.on_key(alt_up),
            vec![
                Action::Replay(Replay::KeyUp(KeyRef {
                    vk: VK_LMENU,
                    scan: 0x38,
                    extended: false,
                })),
                Action::Swallow,
            ]
        );
        assert_eq!(state.on_key(release(VK_D)), vec![Action::Swallow]);
    }

    #[test]
    fn triggering_a_combo_twice_with_alt_held_queues_one_release() {
        let mut state = HookState::new(Hotkey::parse("alt+d").unwrap());
        state.on_key(press(VK_LMENU));
        assert!(state.on_key(press(VK_D)).contains(&Action::Toggle));
        state.on_key(release(VK_D));
        assert!(state.on_key(press(VK_D)).contains(&Action::Toggle));
        let alt_up = state.on_key(release(VK_LMENU));
        assert!(matches!(alt_up[0], Action::Replay(Replay::KeyUp(_))));
        assert!(state.deferred_ups.is_empty());
    }

    #[test]
    fn combo_escape_still_cancels() {
        let mut state = HookState::new(Hotkey::parse("ctrl+space").unwrap());
        state.recording = true;
        state.on_key(press(VK_LCONTROL));
        let cancel = state.on_key(press(VK_ESCAPE));
        assert!(cancel.contains(&Action::Cancel));
    }

    #[test]
    fn ray_injected_events_are_ignored() {
        let mut state = HookState::default();
        let mut injected = press(VK_RMENU);
        injected.ray_injected = true;
        assert_eq!(state.on_key(injected), vec![Action::Pass]);
    }

    #[test]
    fn changing_the_shortcut_swallows_a_held_release() {
        let mut state = HookState::default();
        assert_eq!(state.on_key(press(VK_RMENU)), toggle());
        state.apply_hotkey(Hotkey::parse("f9").unwrap());
        assert_eq!(state.on_key(release(VK_RMENU)), vec![Action::Swallow]);
    }

    #[test]
    fn changing_from_a_modifier_shortcut_does_not_leave_it_stuck_down() {
        let mut state = HookState::default();
        state.on_key(press(VK_RMENU));
        state.apply_hotkey(Hotkey::parse("ctrl+space").unwrap());
        assert_eq!(state.on_key(release(VK_RMENU)), vec![Action::Swallow]);
        // Alt must not linger in the modifier set, or Ctrl+Space never matches.
        state.on_key(press(VK_LCONTROL));
        assert_eq!(state.on_key(press(VK_SPACE)), toggle());
    }

    #[test]
    fn capture_forgets_a_modifier_that_was_already_held() {
        let mut state = HookState::new(Hotkey::parse("ctrl+space").unwrap());
        state.on_key(press(VK_LCONTROL));
        state.begin_capture();
        assert_eq!(state.on_key(release(VK_LCONTROL)), vec![Action::Swallow]);
        state.finish_capture(&[]);
        state.on_key(press(VK_LCONTROL));
        assert_eq!(state.on_key(press(VK_SPACE)), toggle());
    }

    #[test]
    fn capture_a_modifier_tap() {
        let mut state = HookState::default();
        state.begin_capture();
        assert_eq!(state.on_key(press(VK_RMENU)), vec![Action::Swallow]);
        assert_eq!(
            state.on_key(release(VK_RMENU)),
            vec![Action::Captured {
                hotkey: Hotkey::Modifier(SingleModifier::RightAlt),
                label: "Right Alt".into(),
            }]
        );
        // A capture never toggles, even while a recording is running.
        assert_eq!(
            state.on_key(press(VK_RMENU)),
            vec![Action::Toggle, Action::Swallow]
        );
    }

    #[test]
    fn capture_a_combo_and_swallow_its_releases() {
        let mut state = HookState::default();
        state.begin_capture();
        assert_eq!(state.on_key(press(VK_LCONTROL)), vec![Action::Swallow]);
        assert_eq!(state.on_key(press(VK_LSHIFT)), vec![Action::Swallow]);
        assert_eq!(
            state.on_key(press(VK_SPACE)),
            vec![Action::Captured {
                hotkey: Hotkey::parse("ctrl+shift+space").unwrap(),
                label: "Ctrl + Shift + Space".into(),
            }]
        );
        assert_eq!(state.on_key(release(VK_SPACE)), vec![Action::Swallow]);
        assert_eq!(state.on_key(release(VK_LSHIFT)), vec![Action::Swallow]);
        assert_eq!(state.on_key(release(VK_LCONTROL)), vec![Action::Swallow]);
    }

    #[test]
    fn capture_a_single_safe_key() {
        let mut state = HookState::default();
        state.begin_capture();
        assert_eq!(
            state.on_key(press(VK_F1 + 8)),
            vec![Action::Captured {
                hotkey: Hotkey::Key((VK_F1 + 8) as u16),
                label: "F9".into(),
            }]
        );
        assert_eq!(state.on_key(release(VK_F1 + 8)), vec![Action::Swallow]);
    }

    #[test]
    fn capture_rejects_a_lone_letter() {
        let mut state = HookState::default();
        state.begin_capture();
        let rejected = state.on_key(press(VK_A));
        match &rejected[0] {
            Action::CaptureError(message) => assert!(message.contains("modifier"), "{message}"),
            other => panic!("expected a capture error, got {other:?}"),
        }
        assert_eq!(state.on_key(release(VK_A)), vec![Action::Swallow]);
    }

    #[test]
    fn capture_rejects_escape() {
        let mut state = HookState::default();
        state.begin_capture();
        let rejected = state.on_key(press(VK_ESCAPE));
        match &rejected[0] {
            Action::CaptureError(message) => assert!(message.contains("Esc"), "{message}"),
            other => panic!("expected a capture error, got {other:?}"),
        }
        assert_eq!(state.on_key(release(VK_ESCAPE)), vec![Action::Swallow]);
    }

    #[test]
    fn capture_rejects_two_modifiers_without_a_key() {
        let mut state = HookState::default();
        state.begin_capture();
        state.on_key(press(VK_LCONTROL));
        state.on_key(press(VK_LSHIFT));
        state.on_key(release(VK_LSHIFT));
        let rejected = state.on_key(release(VK_LCONTROL));
        match &rejected[0] {
            Action::CaptureError(message) => assert!(message.contains("Add a key"), "{message}"),
            other => panic!("expected a capture error, got {other:?}"),
        }
    }

    #[test]
    fn capture_times_out_and_stale_timers_do_nothing() {
        let mut state = HookState::default();
        let (id, deadline) = state.begin_capture();
        assert!(state.timeout_capture(id + 1, deadline).is_empty());
        let timed_out = state.timeout_capture(id, deadline);
        assert!(matches!(&timed_out[0], Action::CaptureError(_)));
        assert!(state.capture.is_none());
    }

    #[test]
    fn capture_still_works_during_a_recording_without_toggling() {
        let mut state = HookState {
            recording: true,
            ..HookState::default()
        };
        state.begin_capture();
        state.on_key(press(VK_RMENU));
        let captured = state.on_key(release(VK_RMENU));
        assert!(matches!(captured[0], Action::Captured { .. }));
        assert!(!captured.contains(&Action::Toggle));
    }
}
