//! Multi-select export modal.
//!
//! Lifecycle:
//! 1. On open, calls `listAnalyzedSongs()` to populate the checkbox
//!    list. While loading, shows a "Loading…" placeholder.
//! 2. User toggles checkboxes; "Select all" / "Clear" buttons at the
//!    top adjust all at once.
//! 3. On "Export N selected…", opens a folder dialog via `pickFolder`
//!    and then `exportSongZips(fileHashes, destDir)`. The IPC returns
//!    immediately; per-zip results stream back as `export-song-done`
//!    events the parent `StatusView` renders.
//! 4. Empty-state copy ("No analysed songs yet — analyze a song in
//!    Nightingale first.") when the library has nothing to export.
//!
//! This component does NOT render the per-zip result rows itself —
//! they're handled by the unified **Recent imports** list in
//! `StatusView`, so a partial-failure batch doesn't lose the
//! successful exports.

import { useEffect, useMemo, useState } from 'react';

import {
  listAnalyzedSongs,
  exportSongZips,
  type SongSummary,
} from '@/bridge/analyzed-songs';
import { pickFolder } from '@/bridge/folder-picker';

type ExportSongDialogProps = {
  onClose: () => void;
};

export const ExportSongDialog = ({ onClose }: ExportSongDialogProps) => {
  const [songs, setSongs] = useState<readonly SongSummary[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listAnalyzedSongs()
      .then((rows) => {
        if (cancelled) {
          return;
        }
        setSongs(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allHashes = useMemo(() => songs?.map((s) => s.fileHash) ?? [], [songs]);
  const isAllSelected = allHashes.length > 0 && selected.size === allHashes.length;

  const toggle = (fileHash: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(fileHash)) {
        next.delete(fileHash);
      } else {
        next.add(fileHash);
      }
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(allHashes));
  const clearAll = () => setSelected(new Set());

  const onExport = async () => {
    setError(null);
    setBusy(true);
    try {
      const destDir = await pickFolder('Choose a folder for the exported ZIPs');
      if (!destDir) {
        // User cancelled — no rows emitted, no files written.
        return;
      }
      const fileHashes = Array.from(selected);
      await exportSongZips(fileHashes, destDir);
      // The IPC returns immediately; per-zip results appear in the
      // Recent imports list. Close the modal so the user can see them.
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Export your songs"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="modal">
        <header>
          <h1>Export your songs</h1>
          <button
            type="button"
            aria-label="Close"
            className="icon"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        {songs === null && error === null ? (
          <p className="muted">Loading…</p>
        ) : null}

        {error !== null ? <p className="error">{error}</p> : null}

        {songs !== null && songs.length === 0 ? (
          <p className="muted">
            No analysed songs yet — analyze a song in Nightingale first.
          </p>
        ) : null}

        {songs !== null && songs.length > 0 ? (
          <>
            <div className="modal-toolbar">
              <button
                type="button"
                onClick={() => {
                  if (isAllSelected) {
                    clearAll();
                  } else {
                    selectAll();
                  }
                }}
              >
                {isAllSelected ? 'Clear' : 'Select all'}
              </button>
              <span className="muted">
                {selected.size} of {songs.length} selected
              </span>
            </div>

            <ul className="song-list">
              {songs.map((song) => (
                <li key={song.fileHash}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(song.fileHash)}
                      onChange={() => toggle(song.fileHash)}
                    />
                    <span className="text">
                      <strong>{song.title}</strong>
                      <span className="muted"> — {song.artist}</span>
                      {song.album ? (
                        <span className="muted"> ({song.album})</span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={selected.size === 0 || busy}
            onClick={() => {
              void onExport();
            }}
          >
            {busy
              ? 'Exporting…'
              : selected.size === 0
                ? 'Export…'
                : `Export ${selected.size} selected…`}
          </button>
        </div>
      </div>
    </div>
  );
};
