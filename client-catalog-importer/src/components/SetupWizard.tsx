//! First-run setup wizard.
//!
//! Two-step state machine (`system → library`) that prompts the user
//! to point at the on-disk locations the importer needs:
//!
//! - **system folder** — parent of the existing `songs.db`, the
//!   analyzer `cache/` directory, etc. Usually `%USERPROFILE%/.nightingale`.
//! - **library folder** — where catalog songs will be moved (named
//!   `<slug-título>-<artista>-<random>.mp3`). Usually `%USERPROFILE%/Music`.
//!
//! Both pickers call the OS-native folder dialog via
//! `@tauri-apps/plugin-dialog`. "Save" calls
//! `writeImporterConfig` (a Tauri command) which validates server-
//! side before persisting to
//! `%APPDATA%/com.rzru.catalog-importer/config.json`.

import { useState, type FormEvent } from 'react';

import {
  writeImporterConfig,
  type ImporterConfig,
} from '@/bridge/importer-config';
import { pickFolder } from '@/bridge/folder-picker';

type Step = 'system' | 'library';

type SetupWizardProps = {
  initial: ImporterConfig;
  onSaved: () => void;
};

export const SetupWizard = ({ initial, onSaved }: SetupWizardProps) => {
  const [step, setStep] = useState<Step>('system');
  const [systemFolder, setSystemFolder] = useState(initial.systemFolder);
  const [libraryFolder, setLibraryFolder] = useState(initial.libraryFolder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickSystem = async () => {
    const picked = await pickFolder('Select the Nightingale system folder');
    if (picked) {
      setSystemFolder(picked);
      setError(null);
    }
  };

  const pickLibrary = async () => {
    const picked = await pickFolder('Select your music library folder');
    if (picked) {
      setLibraryFolder(picked);
      setError(null);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await writeImporterConfig({
        systemFolder,
        libraryFolder,
        allowedCoverHosts: initial.allowedCoverHosts,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const systemReady = systemFolder.trim().length > 0;
  const libraryReady = libraryFolder.trim().length > 0;
  const canSave = systemReady && libraryReady && !busy;

  return (
    <div className="card">
      <h1>Set up the importer</h1>
      {step === 'system' ? (
        <fieldset>
          <legend>1. Nightingale system folder</legend>
          <p>
            This folder holds <code>songs.db</code>, <code>cache/</code>, and the
            analyzer vendor directory. On Windows it usually lives at{' '}
            <code>%USERPROFILE%\.nightingale</code>.
          </p>
          <div className="row">
            <input
              type="text"
              readOnly
              aria-label="System folder"
              value={systemFolder}
              onClick={() => {
                void pickSystem();
              }}
            />
            <button type="button" onClick={() => {
              void pickSystem();
            }}>
              Browse…
            </button>
          </div>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={!systemReady}
              onClick={() => setStep('library')}
            >
              Next
            </button>
          </div>
        </fieldset>
      ) : (
        <form onSubmit={submit}>
          <fieldset>
            <legend>2. Music library folder</legend>
            <p>
              Catalog songs are saved here as{' '}
              <code>&lt;title&gt;-&lt;artist&gt;-&lt;random&gt;.mp3</code>.
            </p>
            <div className="row">
              <input
                type="text"
                readOnly
                aria-label="Library folder"
                value={libraryFolder}
                onClick={() => {
                  void pickLibrary();
                }}
              />
              <button type="button" onClick={() => {
                void pickLibrary();
              }}>
                Browse…
              </button>
            </div>
          </fieldset>
          {error ? <p className="error">{error}</p> : null}
          <div className="actions">
            <button type="button" onClick={() => setStep('system')}>
              Back
            </button>
            <button type="submit" className="primary" disabled={!canSave}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
};
