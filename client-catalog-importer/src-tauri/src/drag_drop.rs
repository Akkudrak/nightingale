//! Drag-and-drop handler for catalog ZIPs.
//!
//! Mirrors [`crate::deep_link`] but for OS-level file drops onto the
//! importer window instead of `nightingale-import://` deep links. The
//! user drops a `.zip` produced by `app_core::catalog_export` (or by
//! any compatible producer) onto the window and the importer lands it
//! in the user's library exactly the way the deep-link path does,
//! reusing the existing `deep-link-import-done` event so a successful
//! or failed drop surfaces as a row in **Recent imports** without any
//! new UI surface.
//!
//! Non-zip drops still emit a `deep-link-import-done` event with
//! `CatalogImportDone::err(...)` — the StatusView listener renders
//! them as red rows, no separate error UI needed.
//!
//! ## Why this lives in Rust (not JS)
//!
//! The drop payload arrives via Tauri's `WindowEvent::DragDrop` (also
//! re-broadcast as the `tauri://drag-drop` webview event). Tauri's
//! default permissions already let JS subscribe to the webview event,
//! but we still need Rust to actually read the file and call the
//! import pipeline. Doing the validation here (extension + size cap
//! + read into memory) lets us emit a single canonical
//! `CatalogImportDone` for any outcome, which the existing UI
//! listener already knows how to render. A JS-driven flow would
//! still need a Rust command to emit the event for non-zip drops,
//! so the symmetry collapses anyway.

use std::path::{Path, PathBuf};
use std::thread;

use app_core::{
    catalog_import::{import_catalog_zip, CatalogImportDone, MAX_ZIP_BYTES},
    default_config_path, load_importer_config,
};
use tauri::{AppHandle, Emitter, Manager};

const EVENT_NAME: &str = "deep-link-import-done";
const NON_ZIP_ERROR: &str = "drop a .zip catalog bundle — other file types are ignored";

/// Subscribe to `WindowEvent::DragDrop` on the main webview. The
/// subscription is installed on the `WebviewWindow` itself so it
/// survives across reloads of the React UI; the `on_window_event`
/// closure runs on Tauri's main thread, but the actual import work
/// is moved off-thread by [`handle_drop`].
pub(crate) fn register(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        tracing::warn!(
            target: "importer.drag_drop",
            "main webview window not found at drag-drop registration time"
        );
        return;
    };

    let app_for_handler = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
            handle_drop(app_for_handler.clone(), paths.clone());
        }
    });
}

fn handle_drop(app: AppHandle, paths: Vec<PathBuf>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }

    let Some(path) = pick_zip(&paths) else {
        // Even non-zip drops emit an event so the user sees a red row
        // in the same list. Don't silently ignore the drop.
        let app_for_thread = app.clone();
        thread::spawn(move || {
            let _ = app_for_thread.emit(EVENT_NAME, CatalogImportDone::err(NON_ZIP_ERROR.to_string()));
        });
        return;
    };

    let app_for_thread = app.clone();
    thread::spawn(move || {
        let outcome = process_drop(&path);
        let _ = app_for_thread.emit(EVENT_NAME, outcome);
    });
}

fn process_drop(path: &Path) -> CatalogImportDone {
    // 1. Existence + size pre-flight, BEFORE we read into memory.
    //    `MAX_ZIP_BYTES` (64 MiB) is a defence-in-depth guard against
    //    zip-bombs and drag-the-wrong-file mistakes — real catalog
    //    songs are well under 20 MiB.
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) => {
            return CatalogImportDone::err(format!("stat dropped file: {e}"));
        }
    };
    if !meta.is_file() {
        return CatalogImportDone::err(format!(
            "not a regular file: {}",
            path.display()
        ));
    }
    if meta.len() > MAX_ZIP_BYTES {
        return CatalogImportDone::err(format!(
            "dropped file too large ({} bytes; cap {})",
            meta.len(),
            MAX_ZIP_BYTES
        ));
    }

    // 2. Read into memory.
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return CatalogImportDone::err(format!("read dropped zip: {e}")),
    };

    // 3. Config gate — mirrors `deep_link::process` so a drop during
    //    the first-run wizard surfaces the same "importer is not
    //    configured" string the deep-link path uses.
    let cfg = match load_importer_config(&default_config_path()) {
        Ok(c) => c,
        Err(e) => {
            return CatalogImportDone::err(format!(
                "importer is not configured ({e}); run the wizard first"
            ));
        }
    };

    // 4. Delegate to the shared pipeline. Errors here are already
    //    user-readable strings (`CatalogImportError` Display impl).
    match import_catalog_zip(
        &bytes,
        &cfg.system_folder,
        &cfg.library_folder,
        &cfg.allowed_cover_hosts,
    ) {
        Ok(done) => done,
        Err(e) => CatalogImportDone::err(e.to_string()),
    }
}

fn pick_zip(paths: &[PathBuf]) -> Option<PathBuf> {
    paths
        .iter()
        .find(|p| {
            p.extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("zip"))
                .unwrap_or(false)
        })
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn pick_zip_returns_none_for_empty_slice() {
        assert!(pick_zip(&[]).is_none());
    }

    #[test]
    fn pick_zip_returns_none_when_no_extension_matches() {
        let paths = vec![p("/x/song.mp3"), p("/x/cover.jpg"), p("/x/note.txt")];
        assert!(pick_zip(&paths).is_none());
    }

    #[test]
    fn pick_zip_returns_the_zip_when_present() {
        let paths = vec![p("/x/song.mp3"), p("/x/bundle.zip"), p("/x/cover.jpg")];
        assert_eq!(pick_zip(&paths).unwrap(), p("/x/bundle.zip"));
    }

    #[test]
    fn pick_zip_is_case_insensitive_on_extension() {
        let paths = vec![p("/x/BUNDLE.ZIP")];
        assert_eq!(pick_zip(&paths).unwrap(), p("/x/BUNDLE.ZIP"));
    }

    #[test]
    fn pick_zip_returns_first_match_for_mixed_input() {
        let paths = vec![p("/x/first.ZIP"), p("/x/second.zip")];
        assert_eq!(pick_zip(&paths).unwrap(), p("/x/first.ZIP"));
    }
}
