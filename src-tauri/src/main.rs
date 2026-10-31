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
    if let Some(position) = args
        .iter()
        .position(|arg| arg == "--selftest" || arg == "--selftest-stream")
    {
        let streaming = args[position] == "--selftest-stream";
        let Some(path) = args.get(position + 1) else {
            eprintln!("usage: ray --selftest <16kHz-mono.wav>");
            eprintln!("       ray --selftest-stream <16kHz-mono.wav>");
            std::process::exit(2);
        };
        let path = path.clone();
        // The HTTP/TLS futures are large in debug builds; give them room.
        let result = std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(move || ray_lib::run_selftest(&path, streaming))
            .and_then(|handle| {
                handle
                    .join()
                    .map_err(|_| std::io::Error::other("selftest thread panicked"))
            });
        std::process::exit(result.unwrap_or(2));
    }
    ray_lib::run();
}
