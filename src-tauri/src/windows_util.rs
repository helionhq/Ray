//! Windows shell integration: the non-activating click-through floating bar,
//! foreground app detection, and launch-at-login.

use std::path::Path;

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
    SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

const APP_NAME: &str = "Ray";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

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
    }
    Ok(())
}

/// Places the bar at the bottom-center of the work area of the monitor that
/// holds the foreground window, then shows it without activating it.
pub fn show_bar(hwnd: HWND, width: i32, height: i32) -> Result<(), String> {
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

pub fn hide_bar(hwnd: HWND) {
    unsafe {
        let _ = ShowWindow(hwnd, windows::Win32::UI::WindowsAndMessaging::SW_HIDE);
    }
}

/// Bottom-center of the foreground monitor's work area (taskbar excluded),
/// leaving a 10 px gap above it.
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
        let y = bottom - height - 10;
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
