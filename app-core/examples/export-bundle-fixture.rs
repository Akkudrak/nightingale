//! Manual fixture builder: writes a nightingale_song-format ZIP to disk
//! so the operator can inspect it (and so we have a sample file to
//! smoke-test the catalog web admin's "Upload bundle" parser).
//!
//! Run with:
//!     cd nightingale && cargo run -p app-core --example export-bundle-fixture -- <output_path>

use std::path::PathBuf;

use app_core::song_export::build_song_export_zip;
use app_core::{CacheDir, Song, SongOrigin};

fn blake3_short_hex(bytes: &[u8]) -> String {
    let mut h = blake3::Hasher::new();
    h.update(bytes);
    let hash = h.finalize();
    let hex = hash.to_hex();
    String::from(&hex.as_str()[..32])
}

fn main() {
    let out_path: PathBuf = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("nightingale-bundle.zip"));

    let cache_dir = std::env::temp_dir().join("nightingale-bundle-fixture-cache");
    let _ = std::fs::create_dir_all(&cache_dir);
    let audio_path = cache_dir.join("audio.mp3");
    let audio_bytes = b"fake mp3 bytes for the bundle test";
    std::fs::write(&audio_path, audio_bytes).expect("write audio");

    let song = Song {
        path: audio_path.clone(),
        file_hash: blake3_short_hex(audio_bytes),
        title: "Mi Cancion de Prueba".into(),
        artist: "Artista X".into(),
        album: "Album Test".into(),
        duration_secs: 215.5,
        album_art_path: None,
        is_analyzed: true,
        language: Some("es".into()),
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
    let cache = CacheDir {
        path: cache_dir.clone(),
    };
    let bytes = build_song_export_zip(&song, &cache).expect("build bundle");
    std::fs::write(&out_path, &bytes).expect("write zip");

    println!(
        "wrote {} bytes to {} ({} entries inside)",
        bytes.len(),
        out_path.display(),
        // count entries via the ZIP local file headers as a sanity check
        zip_entry_count(&bytes),
    );
}

fn zip_entry_count(bytes: &[u8]) -> usize {
    // Very small, naive scanner: ZIP central directory file headers
    // start with PK\x01\x02. We count them so the operator can see
    // the bundle isn't empty. For real inspection use `unzip -l`.
    bytes
        .windows(4)
        .filter(|w| w[0] == b'P' && w[1] == b'K' && w[2] == 0x01 && w[3] == 0x02)
        .count()
}
