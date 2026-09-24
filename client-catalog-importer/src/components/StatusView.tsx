//! Status view shown after first-run setup completes.
//!
//! - Lists the configured folders read-only (gear icon re-enters setup).
//! - Shows the tail of catalog-bundle operations: deep-link imports and
//!   drag-and-drop imports share `deep-link-import-done`; self-exports
//!   land as `export-song-done`. We merge both into a single **Recent
//!   imports** list so a partial-failure batch doesn't lose the
//!   successful exports — a red dot for the failure, green dots for
//!   the rest.
//! - **Export your songs…** launches `ExportSongDialog` once we've
//!   confirmed the user has at least one analysed song; the button is
//!   hidden otherwise to avoid an empty-state placeholder.

import { useCallback, useEffect, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { listen } from '@tauri-apps/api/event';

import { listAnalyzedSongs } from '@/bridge/analyzed-songs';
import {
  onDeepLinkImportDone,
  type CatalogImportDone,
} from '@/bridge/deep-link';
import type { ImporterConfig } from '@/bridge/importer-config';

import { ExportSongDialog } from './ExportSongDialog';

type RowDirection = 'import' | 'export';

type ImportRow = CatalogImportDone & {
  receivedAt: number;
  direction: RowDirection;
};

type StatusViewProps = {
  config: ImporterConfig;
  onReconfigure: () => void;
};

export const StatusView = ({ config, onReconfigure }: StatusViewProps) => {
  const [imports, setImports] = useState<readonly ImportRow[]>([]);
  const [hasAnalyzedSongs, setHasAnalyzedSongs] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    void onDeepLinkImportDone((payload) => {
      if (!active) {
        return;
      }
      const row: ImportRow = {
        ...payload,
        receivedAt: Date.now(),
        direction: 'import',
      };
      setImports((current) => [row, ...current].slice(0, 50));
    }).then((fn) => {
      if (active) {
        unlisten = fn;
      } else {
        fn();
      }
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    void listen<CatalogImportDone>('export-song-done', (event) => {
      if (!active) {
        return;
      }
      const row: ImportRow = {
        ...event.payload,
        receivedAt: Date.now(),
        direction: 'export',
      };
      setImports((current) => [row, ...current].slice(0, 50));
    }).then((fn) => {
      if (active) {
        unlisten = fn;
      } else {
        fn();
      }
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listAnalyzedSongs()
      .then((rows) => {
        if (!cancelled) {
          setHasAnalyzedSongs(rows.length > 0);
        }
      })
      .catch(() => {
        // Surfacing the error here would be noisy (the user might
        // simply have never opened Nightingale). Hide the button
        // rather than render a red error.
        if (!cancelled) {
          setHasAnalyzedSongs(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const closeExportDialog = useCallback(() => {
    setExportDialogOpen(false);
  }, []);

  return (
    <div className="card">
      <header>
        <h1>Ready</h1>
        <button
          type="button"
          aria-label="Reconfigure folders"
          className="icon"
          onClick={onReconfigure}
        >
          ⚙
        </button>
      </header>

      <dl className="folders">
        <div>
          <dt>System folder</dt>
          <dd>{config.systemFolder}</dd>
        </div>
        <div>
          <dt>Library folder</dt>
          <dd>{config.libraryFolder}</dd>
        </div>
      </dl>

      {hasAnalyzedSongs ? (
        <div className="export-action">
          <button
            type="button"
            className="primary"
            onClick={() => setExportDialogOpen(true)}
          >
            Export your songs…
          </button>
        </div>
      ) : null}

      <section>
        <h2>Recent imports</h2>
        {imports.length === 0 ? (
          <p className="muted">
            Click <em>“Add to Nightingale”</em> from the catalog web, drop a
            catalog <code>.zip</code> here, or export one of your songs.
          </p>
        ) : (
          <ul className="imports">
            {imports.map((row) => (
              <li key={`${row.receivedAt}-${row.fileHash ?? ''}-${row.direction}`}>
                <span className={row.ok ? 'dot ok' : 'dot err'} aria-hidden="true" />
                <span className="text">
                  {row.ok
                    ? `${row.title ?? 'Unknown title'} — ${row.artist ?? 'Unknown artist'}`
                    : `Failed: ${row.error ?? 'unknown error'}`}
                  {row.direction === 'export' && row.ok ? (
                    <span className="tag"> exported</span>
                  ) : null}
                  {row.direction === 'export' && row.ok && row.importedPath ? (
                    <span className="muted"> ({row.importedPath})</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {exportDialogOpen ? <ExportSongDialog onClose={closeExportDialog} /> : null}
    </div>
  );
};
