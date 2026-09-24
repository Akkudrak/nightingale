//! App-level state machine.
//!
//! Three views, hand-rolled since the wizard has only one branching
//! point (system vs library) and a binary toggle to reconfigure:
//!
//! - `loading` — initial `readImporterConfig` in flight.
//! - `setup` — no config or user pressed the gear: render `SetupWizard`.
//! - `ready` — config present: render `StatusView`.
//!
//! The setup wizard seeds itself from a default config returned by
//! `app_core::importer_config::Default`; once `writeImporterConfig`
//! resolves we flip to `ready`.

import { useEffect, useState } from 'react';

import { readImporterConfig, type ImporterConfig } from '@/bridge/importer-config';
import { subscribeToImporterDragDrop } from '@/bridge/drag-drop';
import { SetupWizard } from '@/components/SetupWizard';
import { StatusView } from '@/components/StatusView';

type View =
  | { kind: 'loading' }
  | { kind: 'setup'; initial: ImporterConfig }
  | { kind: 'ready'; config: ImporterConfig };

const fallbackConfig: ImporterConfig = {
  systemFolder: '',
  libraryFolder: '',
  allowedCoverHosts: [],
};

export const App = () => {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const existing = await readImporterConfig();
      if (cancelled) {
        return;
      }
      setView(
        existing
          ? { kind: 'ready', config: existing }
          : { kind: 'setup', initial: fallbackConfig },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Body-class hook for drag-drop visual feedback. The drop itself is
  // consumed by the Rust `drag_drop` handler — by the time the `drop`
  // event reaches JS, the Rust worker has already started the import
  // and the result will arrive via `deep-link-import-done`.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void subscribeToImporterDragDrop((event) => {
      setIsDragging(event.type === 'enter' || event.type === 'over');
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle('is-dragging', isDragging);
    return () => {
      document.body.classList.remove('is-dragging');
    };
  }, [isDragging]);

  if (view.kind === 'loading') {
    return (
      <div className="card">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (view.kind === 'setup') {
    return (
      <SetupWizard
        initial={view.initial}
        onSaved={() => {
          void (async () => {
            const cfg = await readImporterConfig();
            if (cfg) {
              setView({ kind: 'ready', config: cfg });
            }
          })();
        }}
      />
    );
  }

  return (
    <StatusView
      config={view.config}
      onReconfigure={() => {
        setView({ kind: 'setup', initial: view.config });
      }}
    />
  );
};
