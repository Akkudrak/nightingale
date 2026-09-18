//! Manual smoke that produces a real Nightingale-catalog-format ZIP on
//! disk so the operator can inspect it with `unzip -l` and upload it
//! via the catalog admin's "New song" multipart endpoint.
//!
//! Run with:
//!     cd nightingale && cargo run -p app-core --example export-fixture -- <output_path>
//!
//! The output ZIP has a stable root folder (`catalog-fixture-song-<6>`)
//! and the same metadata shape the production exporter produces.

use std::path::PathBuf;

use app_core::catalog_export::CATALOG_ZIP_SCHEMA_VERSION;
use app_core::{Song, SongOrigin};

fn main() {
    let output_path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("catalog-fixture.zip"));

    // Synthetic 4-second fake MP3 bytes (we don't ship a real one; the
    // catalog's multipart validator only checks it's a file with the
    // right mime — and a from-url round-trip doesn't even read it).
    let mp3_path = std::env::temp_dir().join("catalog-fixture.mp3");
    std::fs::write(&mp3_path, b"ID3\x04\x00\x00\x00\x00\x00\x00fake mp3 bytes").expect("write mp3");

    let song = Song {
        path: mp3_path.clone(),
        file_hash: "fixture".into(),
        title: "Catalog Fixture Title".into(),
        artist: "Catalog Fixture Artist".into(),
        album: "Fixture Album".into(),
        duration_secs: 213.7,
        album_art_path: None,
        is_analyzed: true,
        language: Some("EN".into()),
        transcript_source: None,
        key: Some("Am".into()),
        override_key: Some("C".into()),
        tempo: 120.0,
        key_offset: 0,
        is_video: false,
        usdx: None,
        origin: SongOrigin::LocalFile,
        no_stems: false,
        genre: None,
        added_at: 0,
    };

    let metadata = format!("(see inside ZIP at <root>/metadata.json)");
    println!("schema_version  = {CATALOG_ZIP_SCHEMA_VERSION}");
    println!("metadata json   = {metadata}");
    println!("writing ZIP to  = {}", output_path.display());

    let bytes =
        app_core::catalog_export::write_catalog_zip_to(&song, &output_path).expect("export");
    println!("wrote {} bytes", bytes);
}
