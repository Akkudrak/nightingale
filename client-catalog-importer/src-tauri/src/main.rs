// Hide the console window in release on Windows; in debug the console
// helps read `tracing` output without piping through DevTools.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    importer_lib::run()
}
