# Online Catalog Imports

Beyond scanning a local folder, Plex, Jellyfin, Navidrome, or UltraStar libraries, Nightingale can also accept songs from **online catalogs** through a small companion app called the **catalog importer** (`client-catalog-importer/`).

The catalog importer is a separate Tauri 2 mini-app that runs alongside your main Nightingale install. It receives `nightingale-import://…` deep links, downloads the catalog ZIP the URL points at, validates the bundle, and lands the song directly in your existing Nightingale library — without touching `~/.nightingale/config.json` and without needing you to keep Nightingale open.

## When to use it

Use the catalog importer when a host (a website, a friend, the project itself, a Discord bot) shares a Nightingale song URL with you. Clicking the link launches the importer, which downloads the song, hashes the MP3 with the same blake3 prefix every other Nightingale song uses, drops the cover into `cache/<hash>_cover.jpg`, renames the MP3 to `<slug título>-<artista>-<XXXXXX>.mp3` in your library folder, and writes a row into the existing `songs.db`.

The catalog importer works with **Nightingale 1.0.0 and newer**, including the desktop app you may already have. Nightingale 1.3+ keeps using its native `nightingale://` deep-link scheme — the two are independent.

## Install

The catalog importer is a standalone binary that ships next to your existing Nightingale install (Windows, macOS, Linux). On Windows the desktop installer places `catalog-importer.exe` next to `Nightingale.exe`; on macOS the bundle ships the same `.app`; on Linux the `.deb` / `.rpm` install puts it under `/usr/bin/`.

Once installed, the importer registers itself as the system handler for the `nightingale-import://` URL scheme. Most operating systems ask once to confirm the association; click **Open with Nightingale Catalog Importer** (or just **Open**).

## First run

The first time you click a catalog link, the importer shows a two-step wizard before downloading anything:

1. **System folder** — the directory that contains your existing `songs.db` and `cache/`. The importer only reads `songs.db` (to probe the current schema) and only writes `songs.db` + `cache/` under this folder. It never reads or writes `~/.nightingale/config.json`.
2. **Library folder** — the directory the imported MP3 should land in. The importer renames the file to the same `<slug título>-<artista>-<XXXXXX>.mp3` convention that [catalog exports](./configuration.md) use, so a future re-export of the same song round-trips cleanly.

Both choices are persisted to:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\com.rzru.catalog-importer\config.json` |
| macOS | `~/Library/Application Support/com.rzru.catalog-importer/config.json` |
| Linux | `~/.config/com.rzru.catalog-importer/config.json` |

The wizard only appears once. Subsequent catalog links skip straight to the status view.

## What it does

When you click a `nightingale-import://…` URL, the importer:

1. **Downloads** the catalog ZIP the URL points at to a temporary file under the system folder. The HTTP client uses `native-tls` so downloads survive Avast Web Shield and similar MITM proxies on Windows hosts.
2. **Validates** the ZIP structure against the catalog schema (`CATALOG_ZIP_SCHEMA_VERSION`). Bundles with the wrong schema or a corrupt MP3 surface a clear error toast.
3. **Hashes** the MP3 with the same blake3 prefix the rest of Nightingale uses, so the resulting `<hash>` matches what stem separation, transcription, and scoring will write into their cache keys.
4. **Drops the cover** into `cache/<hash>_cover.jpg` (only when the source URL is on an allow-list of known image hosts; off-list URLs are skipped silently).
5. **Renames the MP3** to `<slug título>-<artista>-<XXXXXX>.mp3` and writes it to your library folder.
6. **Inserts** the song into `songs.db` via `upsert_song_compat`, which probes `PRAGMA table_info(songs)` and builds a dynamic `INSERT` so Nightingale 1.x, 2.x, and 3.x schemas all work without a forced migration.

Schema migrations are intentionally skipped on the importer side (`MigrateMode::ProbeOnly`). The importer never alters your DB behind your back — `genre` and `added_at` only appear once the main Nightingale app itself migrates the connection.

Concurrent main-app writes (you're singing while an import lands) are absorbed by a 3-attempt retry with 250 / 500 ms backoff on `SQLITE_BUSY` / `SQLITE_LOCKED`.

## Permissions

The catalog importer runs with the smallest capability set that fits its job:

| Capability | Why |
|---|---|
| `core:default` | base window + IPC plumbing |
| `core:window:allow-set-focus` | pop the importer to the front when a deep link arrives |
| `core:window:allow-show` | show the wizard / status view after the OS hands over the URL |
| `dialog:default` | folder picker for the first-run wizard |
| `deep-link:default` | receive `nightingale-import://` URLs |

Notably absent: `opener`, `process`, `updater`, and `assetProtocol`. The importer cannot open arbitrary URLs in the user's browser, spawn child processes, check for updates, or read arbitrary files on disk. CSP is `default-src 'self' ipc: http://ipc.localhost`.

## Status view

After a download starts, the importer switches to a status view that shows:

- The song title and artist as the importer reads them from the ZIP manifest.
- A progress indicator for the download + validation steps.
- A success line with the path the MP3 landed at, or an error toast with the underlying message on failure.

Closing the importer window keeps the download running in the background; reopening it shows the current status again. The importer auto-closes a few seconds after a successful import so it stays out of the way.

## Troubleshooting

**"SQLITE_BUSY" or "database is locked"** — the main Nightingale app is writing to `songs.db` at the same moment. The importer retries automatically (3 attempts, 250 / 500 ms backoff). If the error persists, close Nightingale once and re-click the catalog link; the importer writes without contention.

**"Catalog schema version X is not supported"** — the catalog you received was generated by a newer or incompatible version of Nightingale. Ask whoever shared the link to re-export the song from a compatible build, or pull the latest release from the project's release page.

**Cover image was skipped** — the cover URL in the catalog ZIP is on a host the importer doesn't allow. Nightingale downloads covers only from a fixed allow-list of image hosts to keep the importer from making arbitrary network requests; the song still imports, just without a cover. You can drop a `cover.jpg` next to the MP3 manually and the main app will pick it up on the next scan.

**Importer doesn't open on click** — the OS didn't route the URL to the importer. On Windows, set the default handler under **Settings → Apps → Default apps → nightingale-import**. On macOS, the first `nightingale-import://` click triggers a prompt to pick the handler; choose **Nightingale Catalog Importer** and tick **Always use this app**. On Linux, the importer's `.desktop` file ships the `MimeType=x-scheme-handler/nightingale-import;` line — re-run `update-desktop-database ~/.local/share/applications` after install.

**Folder choice is wrong** — quit the importer, edit the JSON file at the path above (the keys are `system_folder` and `library_folder`), relaunch. The wizard will not reappear; the importer picks up the new values on the next deep-link click.
