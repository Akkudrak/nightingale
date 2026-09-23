//! Status view shown after first-run setup completes.
//!
//! - Lists the configured folders read-only (gear icon re-enters setup).
//! - Shows the tail of deep-link imports. The Tauri Rust worker emits
//!   `deep-link-import-done` per URL; we append each one to the top of
//!   the list (newest first), with a green dot for success and the
//!   error string in red for failure.

import { useEffect, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';

import {
  onDeepLinkImportDone,
  type CatalogImportDone,
} from '@/bridge/deep-link';
import type { ImporterConfig } from '@/bridge/importer-config';

type ImportRow = CatalogImportDone & { receivedAt: number };

type StatusViewProps = {
  config: ImporterConfig;
  onReconfigure: () => void;
};

export const StatusView = ({ config, onReconfigure }: StatusViewProps) => {
  const [imports, setImports] = useState<readonly ImportRow[]>([]);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    void onDeepLinkImportDone((payload) => {
      if (!active) {
        return;
      }
      setImports((current) =>
        [{ ...payload, receivedAt: Date.now() }, ...current].slice(0, 50),
      );
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

      <section>
        <h2>Recent imports</h2>
        {imports.length === 0 ? (
          <p className="muted">
            Click <em>“Add to Nightingale”</em> from the catalog web to send songs here.
          </p>
        ) : (
          <ul className="imports">
            {imports.map((row) => (
              <li key={`${row.receivedAt}-${row.fileHash ?? ''}`}>
                <span className={row.ok ? 'dot ok' : 'dot err'} aria-hidden="true" />
                <span className="text">
                  {row.ok
                    ? `${row.title ?? 'Unknown title'} — ${row.artist ?? 'Unknown artist'}`
                    : `Failed: ${row.error ?? 'unknown error'}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
