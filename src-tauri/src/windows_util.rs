//! Windows shell integration: the non-activating click-through floating bar,
//! foreground app detection, and launch-at-login.

use std::ffi::c_void;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE,
    HWND_TOPMOST, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    SW_HIDE, SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

const APP_NAME: &str = "Ray";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// The bar window's logical height (matches `tauri.conf.json`). Hex's HUD
/// window is 304 × 80 pt; the plate sits in the middle.
const BAR_WINDOW_HEIGHT: f32 = 80.0;
/// Hex's gap from the bottom edge of the work area to the HUD window, pt.
const BAR_BOTTOM_OFFSET: f32 = 24.0;
/// Hex hides the HUD once Dot scope has faded out: 0.3 s spring, settling
/// under 0.2 % opacity. Leave the window up until that has played.
const BAR_HIDE_DELAY: Duration = Duration::from_millis(420);

/// Bumped on every show/hide so a delayed hide from an earlier phase never
/// takes down a bar that has been shown again since.
static BAR_GENERATION: AtomicU64 = AtomicU64::new(0);

// The DWM attributes for an undecorated, transparent window. `dwmapi` is
// linked directly so the bar does not need another `windows` crate feature.
#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: *mut c_void,
        attribute: u32,
        value: *const c_void,
        size: u32,
    ) -> i32;
}

const DWMWA_NCRENDERING_POLICY: u32 = 2;
const DWMNCRP_DISABLED: i32 = 1;
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
const DWMWCP_DONOTROUND: i32 = 1;
const DWMWA_BORDER_COLOR: u32 = 34;
const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;

/// Turns off the parts of the window frame DWM still draws around a
/// transparent window: its shadow, border, and rounded corners.
fn remove_dwm_frame(hwnd: HWND) {
    unsafe {
        let hwnd = hwnd.0;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_NCRENDERING_POLICY,
            &DWMNCRP_DISABLED as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        );
        // Windows 11 only; Windows 10 returns an error, which is fine.
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &DWMWCP_DONOTROUND as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &DWMWA_COLOR_NONE as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Foreground {
    pub hwnd: isize,
    pub app: Option<String>,
    pub title: Option<String>,
}

/// Makes the window invisible to Alt+Tab and the taskbar, unable to take
/// focus, and transparent to the mouse.
pub fn style_bar(hwnd: HWND) -> Result<(), String> {
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let styles = current
            | WS_EX_NOACTIVATE.0 as isize
            | WS_EX_TOOLWINDOW.0 as isize
            | WS_EX_TRANSPARENT.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, styles);
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
        .map_err(|error| format!("Could not style the bar window: {error}"))?;
        remove_dwm_frame(hwnd);
    }
    Ok(())
}

/// Places the bar at the bottom-center of the work area of the monitor that
/// holds the foreground window, then shows it without activating it.
pub fn show_bar(hwnd: HWND, width: i32, height: i32) -> Result<(), String> {
    BAR_GENERATION.fetch_add(1, Ordering::SeqCst);
    let (x, y) = bottom_center(width, height).unwrap_or((0, 0));
    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
        .map_err(|error| format!("Could not position the bar: {error}"))?;
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    Ok(())
}

/// Keeps the window up long enough for the bar to play its 0.3 s fade, then
/// hides it — unless a new show has happened in the meantime.
pub fn hide_bar(hwnd: HWND) {
    let generation = BAR_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let raw = hwnd.0 as isize;
    std::thread::spawn(move || {
        std::thread::sleep(BAR_HIDE_DELAY);
        if BAR_GENERATION.load(Ordering::SeqCst) == generation {
            unsafe {
                let _ = ShowWindow(HWND(raw as *mut c_void), SW_HIDE);
            }
        }
    });
}

/// Bottom-center of the foreground monitor's work area (taskbar excluded),
/// leaving Hex's 24 pt gap above it. The gap is kept in points, so it scales
/// with the window: the window is 80 logical px tall at every DPI.
fn bottom_center(width: i32, height: i32) -> Option<(i32, i32)> {
    unsafe {
        let monitor = MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let RECT {
            left,
            top: _,
            right,
            bottom,
        } = info.rcWork;
        let width_available = right - left;
        let x = left + (width_available - width).max(0) / 2;
        let scale = height as f32 / BAR_WINDOW_HEIGHT;
        let gap = (BAR_BOTTOM_OFFSET * scale).round() as i32;
        let y = bottom - height - gap;
        Some((x, y))
    }
}

pub fn foreground() -> Option<Foreground> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let title = window_title(hwnd);
        let app = window_process_name(hwnd).map(|name| friendly_app_name(&name));
        Some(Foreground {
            hwnd: hwnd.0 as isize,
            app,
            title,
        })
    }
}

fn window_title(hwnd: HWND) -> Option<String> {
    unsafe {
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 {
            return None;
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let written = GetWindowTextW(hwnd, &mut buffer);
        if written <= 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..written as usize]))
    }
}

fn window_process_name(hwnd: HWND) -> Option<String> {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0u16; MAX_PATH as usize * 4];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        let file = Path::new(&path).file_stem()?.to_string_lossy().to_string();
        Some(file)
    }
}

pub fn friendly_app_name(process: &str) -> String {
    let lower = process.to_lowercase();
    let known = match lower.as_str() {
        "notepad" => "Notepad",
        "notepad++" => "Notepad++",
        "chrome" => "Google Chrome",
        "msedge" => "Microsoft Edge",
        "firefox" => "Firefox",
        "brave" => "Brave",
        "code" => "Visual Studio Code",
        "cursor" => "Cursor",
        "devenv" => "Visual Studio",
        "slack" => "Slack",
        "discord" => "Discord",
        "teams" | "ms-teams" => "Microsoft Teams",
        "outlook" => "Outlook",
        "winword" => "Microsoft Word",
        "excel" => "Microsoft Excel",
        "powerpnt" => "Microsoft PowerPoint",
        "powershell" | "pwsh" => "PowerShell",
        "windowsterminal" | "wt" => "Windows Terminal",
        "cmd" => "Command Prompt",
        "explorer" => "File Explorer",
        "whatsapp" => "WhatsApp",
        "telegram" => "Telegram",
        "notion" => "Notion",
        "figma" => "Figma",
        "obsidian" => "Obsidian",
        "spotify" => "Spotify",
        "zoom" => "Zoom",
        "idea64" => "IntelliJ IDEA",
        "sublime_text" => "Sublime Text",
        _ => return title_case(process),
    };
    known.to_string()
}

fn title_case(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => APP_NAME.to_string(),
    }
}

pub fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(RUN_KEY, KEY_READ | KEY_WRITE)
        .or_else(|_| hkcu.create_subkey(RUN_KEY).map(|(key, _)| key))
        .map_err(|error| format!("Could not open the startup registry key: {error}"))?;
    if enabled {
        let exe = std::env::current_exe()
            .map_err(|error| format!("Could not find the Ray executable: {error}"))?;
        let value = format!("\"{}\" --autostart", exe.display());
        key.set_value(APP_NAME, &value)
            .map_err(|error| format!("Could not enable launch at login: {error}"))?;
    } else {
        match key.delete_value(APP_NAME) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not disable launch at login: {error}")),
        }
    }
    Ok(())
}

pub fn launch_at_login() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey_with_flags(RUN_KEY, KEY_READ)
        .and_then(|key| key.get_value::<String, _>(APP_NAME))
        .is_ok()
}

/// UTF-16 for Win32 paths.
#[allow(dead_code)]
pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
