#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args_os().nth(1).is_some_and(|arg| arg == "mcp") {
        if let Err(message) = markdraw_lib::mcp_server::run_stdio() {
            eprintln!("{message}");
            std::process::exit(1);
        }
        return;
    }
    markdraw_lib::run();
}
