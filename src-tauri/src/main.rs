#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--selftest-mic") {
        let result = std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(ray_lib::run_mic_test)
            .and_then(|handle| {
                handle
                    .join()
                    .map_err(|_| std::io::Error::other("mic selftest panicked"))
            });
        std::process::exit(result.unwrap_or(2));
    }
    if let Some(position) = args.iter().position(|arg| {
        arg == "--selftest" || arg == "--selftest-stream" || arg == "--selftest-resample"
    }) {
        let flag = args[position].as_str();
        let streaming = flag != "--selftest";
        let resample = flag == "--selftest-resample";
        let Some(path) = args.get(position + 1) else {
            eprintln!("usage: ray --selftest <16kHz-mono.wav> [--mode clean|structured]");
            eprintln!("       ray --selftest-stream <16kHz-mono.wav> [--mode clean|structured]");
            eprintln!(
                "       ray --selftest-resample <any-rate-mono.wav> [--mode clean|structured]"
            );
            eprintln!("       (or set RAY_CLEANUP_MODE=clean|structured)");
            std::process::exit(2);
        };
        // `--mode structured` is sugar for the env var the selftest reads, so
        // both entry points share one implementation. See selftest.rs.
        if let Some(mode) = cleanup_mode_arg(&args) {
            if !mode.eq_ignore_ascii_case("clean") && !mode.eq_ignore_ascii_case("structured") {
                eprintln!("--mode must be clean or structured, got {mode:?}");
                std::process::exit(2);
            }
            std::env::set_var("RAY_CLEANUP_MODE", mode);
        }
        let path = path.clone();
        // The HTTP/TLS futures are large in debug builds; give them room.
        let result = std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                if resample {
                    ray_lib::run_selftest_resampled(&path, streaming)
                } else {
                    ray_lib::run_selftest(&path, streaming)
                }
            })
            .and_then(|handle| {
                handle
                    .join()
                    .map_err(|_| std::io::Error::other("selftest thread panicked"))
            });
        std::process::exit(result.unwrap_or(2));
    }
    ray_lib::run();
}

/// Accept both `--mode structured` and `--mode=structured`.
fn cleanup_mode_arg(args: &[String]) -> Option<String> {
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--mode" {
            return args.get(index + 1).cloned();
        }
        if let Some(value) = arg.strip_prefix("--mode=") {
            return Some(value.to_string());
        }
        index += 1;
    }
    None
}
