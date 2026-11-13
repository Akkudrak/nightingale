//! Downloads queued songs' `.nge` bundles into the pinned folder library and
//! registers them, one at a time (MEGA dislikes parallel transfers, and a room
//! only needs the next song or two ready). Bundles are named after their
//! SingVerse song id, so a song sung again is already on disk. The folder is
//! kept under a size cap, least recently used first.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::Semaphore;

use super::mega;

/// Where a song's bundle stands, as the screen shows it.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub(crate) enum Prep {
    Queued,
    Downloading { received: u64, total: u64 },
    Ready { song: Box<app_core::Song> },
    Failed { error: String },
}

/// What SingVerse says about where a song's `.nge` lives.
#[derive(Clone, Debug)]
pub(crate) struct SongSource {
    pub(crate) song_id: String,
    pub(crate) kind: String,
    pub(crate) url: String,
}

impl SongSource {
    /// From a queue item of SingVerse's room state.
    pub(crate) fn from_item(item: &Value) -> Option<Self> {
        let song_id = item.pointer("/song/id")?.as_str()?;
        let kind = item.pointer("/source/kind")?.as_str()?;
        let url = item.pointer("/source/url")?.as_str()?;
        super::auth::is_uuid(song_id).then(|| Self {
            song_id: song_id.to_string(),
            kind: kind.to_string(),
            url: url.to_string(),
        })
    }
}

const CHUNK: usize = 256 * 1024;
/// Bundles above this are refused (a karaoke .nge is ~10–40 MB; video ones more).
const MAX_BYTES: u64 = 1024 * 1024 * 1024;

pub(crate) struct Downloader {
    library: PathBuf,
    cache_bytes: u64,
    preps: Mutex<HashMap<String, Prep>>,
    one_at_a_time: Semaphore,
}

impl Downloader {
    pub(crate) fn new(library: PathBuf, cache_bytes: u64) -> Self {
        Self {
            library,
            cache_bytes,
            preps: Mutex::new(HashMap::new()),
            one_at_a_time: Semaphore::new(1),
        }
    }

    fn bundle_path(&self, song_id: &str) -> PathBuf {
        self.library.join(format!("{song_id}.nge"))
    }

    pub(crate) fn status(&self, song_id: &str) -> Option<Prep> {
        self.preps.lock().ok()?.get(song_id).cloned()
    }

    fn set(&self, song_id: &str, prep: Prep) {
        if let Ok(mut preps) = self.preps.lock() {
            preps.insert(song_id.to_string(), prep);
        }
    }

    /// Starts preparing the song unless it is ready or already on its way.
    /// A failed one is retried when asked again.
    pub(crate) fn ensure(self: &Arc<Self>, source: SongSource) {
        let should_start = match self.preps.lock() {
            Ok(mut preps) => match preps.get(&source.song_id) {
                Some(Prep::Ready { .. } | Prep::Queued | Prep::Downloading { .. }) => false,
                _ => {
                    preps.insert(source.song_id.clone(), Prep::Queued);
                    true
                }
            },
            Err(_) => false,
        };
        if !should_start {
            return;
        }

        let this = Arc::clone(self);
        tokio::spawn(async move {
            let Ok(_permit) = this.one_at_a_time.acquire().await else {
                return;
            };
            let worker = Arc::clone(&this);
            let song_id = source.song_id.clone();
            let result = tokio::task::spawn_blocking(move || worker.prepare(&source)).await;
            let prep = match result {
                Ok(Ok(song)) => Prep::Ready {
                    song: Box::new(song),
                },
                Ok(Err(error)) => {
                    tracing::warn!(%song_id, "singverse bundle failed: {error}");
                    Prep::Failed { error }
                }
                Err(error) => Prep::Failed {
                    error: error.to_string(),
                },
            };
            this.set(&song_id, prep);
        });
    }

    /// Blocking: download if missing, then register in the library.
    fn prepare(&self, source: &SongSource) -> Result<app_core::Song, String> {
        let path = self.bundle_path(&source.song_id);

        if !path.exists() {
            let partial = path.with_extension("nge.part");
            let result = self.download(source, &partial);
            if let Err(error) = result {
                let _ = fs::remove_file(&partial);
                return Err(error);
            }
            fs::rename(&partial, &path).map_err(|e| e.to_string())?;
        }

        // Played now: freshest in the eviction order.
        let _ = File::options()
            .write(true)
            .open(&path)
            .and_then(|f| f.set_modified(SystemTime::now()));

        let song = app_core::singverse::import_nge_bundle(&path).map_err(|e| {
            // A bundle Nightingale can't read is useless on disk.
            let _ = fs::remove_file(&path);
            format!("not a playable .nge: {e}")
        })?;

        self.evict(&path);
        Ok(song)
    }

    fn download(&self, source: &SongSource, dest: &Path) -> Result<(), String> {
        let agent = ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(20)))
            // A whole bundle over a slow link: generous, but a stalled transfer still ends.
            .timeout_recv_body(Some(Duration::from_secs(15 * 60)))
            .build()
            .new_agent();

        let (url, mut cipher) = match source.kind.as_str() {
            "mega" => {
                let link = mega::parse_link(&source.url).ok_or("not a MEGA file link")?;
                let (url, _) = link.download_url()?;
                (url, Some(link.decryptor()))
            }
            "storage" | "pixeldrain" => (source.url.clone(), None),
            other => return Err(format!("unsupported source kind {other}")),
        };

        let mut response = agent
            .get(&url)
            .call()
            .map_err(|e| format!("download: {e}"))?;
        let total = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        if total > MAX_BYTES {
            return Err("bundle too large".into());
        }

        let mut reader = response.body_mut().as_reader();
        let mut file = File::create(dest).map_err(|e| e.to_string())?;
        let mut buffer = vec![0u8; CHUNK];
        let mut received: u64 = 0;
        let mut last_report = 0u64;

        loop {
            let n = reader
                .read(&mut buffer)
                .map_err(|e| format!("download: {e}"))?;
            if n == 0 {
                break;
            }
            let chunk = &mut buffer[..n];
            if let Some(cipher) = cipher.as_mut() {
                mega::decrypt(cipher, chunk);
            }
            file.write_all(chunk).map_err(|e| e.to_string())?;
            received += n as u64;
            if received > MAX_BYTES {
                return Err("bundle too large".into());
            }
            if received - last_report >= 1024 * 1024 {
                last_report = received;
                self.set(&source.song_id, Prep::Downloading { received, total });
            }
        }
        file.flush().map_err(|e| e.to_string())?;

        if total > 0 && received != total {
            return Err(format!("download cut short ({received} of {total} bytes)"));
        }
        Ok(())
    }

    /// Deletes the least recently used bundles over the cap (never `keep`),
    /// then drops their library rows.
    fn evict(&self, keep: &Path) {
        let Ok(entries) = fs::read_dir(&self.library) else {
            return;
        };
        let mut bundles: Vec<(PathBuf, u64, SystemTime)> = entries
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "nge"))
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                Some((
                    e.path(),
                    meta.len(),
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                ))
            })
            .collect();

        let mut total: u64 = bundles.iter().map(|(_, size, _)| size).sum();
        if total <= self.cache_bytes {
            return;
        }

        bundles.sort_by_key(|(_, _, modified)| *modified);
        let mut removed = false;
        for (path, size, _) in &bundles {
            if total <= self.cache_bytes {
                break;
            }
            if path == keep {
                continue;
            }
            if fs::remove_file(path).is_ok() {
                total = total.saturating_sub(*size);
                removed = true;
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if let Ok(mut preps) = self.preps.lock() {
                        preps.remove(stem);
                    }
                }
            }
        }

        if removed {
            let kept: Vec<String> = bundles
                .iter()
                .map(|(path, _, _)| path)
                .filter(|path| path.exists())
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            if let Err(error) = app_core::singverse::prune_library_paths(&kept) {
                tracing::warn!("could not prune evicted bundles: {error}");
            }
        }
    }
}
