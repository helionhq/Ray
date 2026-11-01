//! Windows shell integration: the non-activating click-through floating bar,
//! foreground app detection, and launch-at-login.

use std::ffi::c_void;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, MAX_PATH, RECT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetAncestor, GetForegroundWindow,
    GetMessageW, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    RegisterClassW, SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage, GA_ROOT,
    GA_ROOTOWNER, GWL_EXSTYLE, HWND_MESSAGE, HWND_TOPMOST, MSG, SWP_FRAMECHANGED, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE, WINDOW_EX_STYLE,
    WINDOW_STYLE, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
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

/// Lower-case executable stem of the foreground window, for paste timing.
pub fn foreground_process_name() -> Option<String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        window_process_name(hwnd)
    }
}

/// The foreground window's handle, without the process/title lookups. Used to
/// confirm the window the user started dictating in is still the one focused
/// right before Ray sends Ctrl+V.
pub fn foreground_hwnd() -> Option<isize> {
    unsafe {
        let hwnd = GetForegroundWindow();
        (!hwnd.0.is_null()).then_some(hwnd.0 as isize)
    }
}

/// Ray's clipboard owner window, created lazily on first use.
///
/// `OpenClipboard(NULL)` is documented to make the following `EmptyClipboard`
/// leave the clipboard owner NULL, which in turn makes every
/// `SetClipboardData` call fail. Opening on a real window avoids that. The
/// window must outlive the writes, and Windows destroys a window when the
/// thread that created it exits, so it lives on a dedicated thread that pumps
/// messages for the rest of the process. Data written with SetClipboardData
/// (no delayed rendering) belongs to the system and survives the owner, but
/// the process keeps using the handle for every write and restore.
/// Stored as `isize` because raw window handles are not `Send`/`Sync`; the
/// value is never dereferenced across threads.
static CLIPBOARD_OWNER: OnceLock<Option<isize>> = OnceLock::new();

pub fn clipboard_owner() -> Option<isize> {
    *CLIPBOARD_OWNER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let spawned = std::thread::Builder::new()
            .name("ray-clipboard-owner".into())
            .spawn(move || {
                let hwnd = unsafe { create_clipboard_window() };
                let _ = tx.send(hwnd.map(|hwnd| hwnd.0 as isize));
                if hwnd.is_some() {
                    unsafe { clipboard_message_loop() };
                }
            });
        if spawned.is_err() {
            return None;
        }
        // The window is small and cheap; if setup somehow stalls, fail the
        // clipboard write rather than hanging the pipeline.
        rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
    })
}

unsafe fn create_clipboard_window() -> Option<HWND> {
    let instance = unsafe { GetModuleHandleW(None) }.ok()?;
    let class_name = wide("RayClipboardOwner");
    let class = WNDCLASSW {
        lpfnWndProc: Some(clipboard_window_proc),
        hInstance: HINSTANCE::from(instance),
        lpszClassName: PCWSTR(class_name.as_ptr()),
        ..Default::default()
    };
    // A zero return means registration failed; CreateWindowEx below decides
    // whether that matters (it still works if the class already exists).
    unsafe { RegisterClassW(&class) };
    unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(class_name.as_ptr()),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(HINSTANCE::from(instance)),
            None,
        )
    }
    .ok()
}

unsafe extern "system" fn clipboard_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

unsafe fn clipboard_message_loop() {
    let mut message = MSG::default();
    loop {
        // 0 means WM_QUIT and -1 means an error; either way there is nothing
        // left to pump.
        if unsafe { GetMessageW(&mut message, None, 0, 0) }.0 <= 0 {
            break;
        }
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

/// Returns a user-facing reason when Ctrl+V would not reach the focused
/// window. UIPI blocks synthetic input into elevated windows without an error,
/// so those cases must be detected before sending anything.
pub fn paste_blocker() -> Option<String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return Some("No window is focused to paste into".into());
        }
        // The focused window can be a WebView2/child window; walk to the
        // top-level owner so "Ray's own window" is recognised reliably.
        let mut pid = 0u32;
        let mut top = hwnd;
        for flags in [GA_ROOT, GA_ROOTOWNER] {
            let ancestor = GetAncestor(hwnd, flags);
            if !ancestor.0.is_null() {
                top = ancestor;
                break;
            }
        }
        GetWindowThreadProcessId(top, Some(&mut pid));
        if pid == 0 {
            return Some("Ray could not tell which window is focused".into());
        }
        if pid == GetCurrentProcessId() {
            return Some("Ray's own window is focused".into());
        }
        let self_elevated = process_is_elevated(GetCurrentProcessId()).unwrap_or(false);
        if self_elevated {
            return None;
        }
        match process_is_elevated(pid) {
            Some(true) => Some(
                "The focused window is running as administrator, and Windows blocks paste into it"
                    .into(),
            ),
            // Access denied here usually means a higher-integrity process; be
            // honest rather than silently dropping the keystroke.
            None => Some(
                "Ray could not send input to the focused window; it may be running as administrator"
                    .into(),
            ),
            Some(false) => None,
        }
    }
}

fn process_is_elevated(pid: u32) -> Option<bool> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut token = HANDLE::default();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token).is_ok();
        if !opened {
            let _ = CloseHandle(process);
            return None;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = 0u32;
        let queried = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut TOKEN_ELEVATION as *mut std::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(token);
        let _ = CloseHandle(process);
        queried.then_some(elevation.TokenIsElevated != 0)
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
    let Ok(value) = hkcu
        .open_subkey_with_flags(RUN_KEY, KEY_READ)
        .and_then(|key| key.get_value::<String, _>(APP_NAME))
    else {
        return false;
    };
    // A Run entry left behind by a moved or older build does not mean the
    // current Ray will start at login. Reporting it as off lets the user fix
    // it by turning the switch on again.
    match std::env::current_exe() {
        Ok(exe) => value
            .to_lowercase()
            .contains(&exe.display().to_string().to_lowercase()),
        Err(_) => true,
    }
}

/// UTF-16 for Win32 paths.
#[allow(dead_code)]
pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
