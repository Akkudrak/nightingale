import { useCallback, useState, type ReactElement } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

import { EXIT_SUPPORTED, exit as exitApp } from '@/bridge/exit';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/components/ui/alert-dialog';

type ConfigPatch = Record<string, unknown>;
type ConfigMutate = (patch: ConfigPatch) => void;

type UseServerGuestModeOptions = {
  mutate: ConfigMutate;
};

type UseServerGuestModeResult = {
  requestOpen: () => void;
  Dialog: ReactElement | null;
};

// Owns the state, the confirm handler, and the JSX for the
// Server/Guest mode confirmation dialog. Extracted from
// `settings.tsx` so the main SettingsPage component stays below the
// oxlint `complexity` cap (10). Settings just calls
// `requestOpen()` when the user picks `server_guest` from the
// playback mode select, and renders the returned `Dialog` once.
export const useServerGuestMode = ({
  mutate,
}: UseServerGuestModeOptions): UseServerGuestModeResult => {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  const requestOpen = useCallback(() => {
    setOpen(true);
  }, []);

  const onConfirm = useCallback(async () => {
    if (switching) {
      return;
    }
    setSwitching(true);
    try {
      mutate({ playback_mode: 'server_guest' });
      const url = await invoke<string>('enter_server_guest_mode');
      toast.success(`Server running at ${url}`, {
        duration: 15000,
        description: 'Open the URL in your browser, or scan the /guest QR from another device.',
      });
      await exitApp();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Could not switch to Server/Guest mode: ${message}`);
      setSwitching(false);
    }
  }, [mutate, switching]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (switching) {
        return;
      }
      setOpen(next);
    },
    [switching],
  );

  const handleActionClick = useCallback((event: { preventDefault: () => void }) => {
    event.preventDefault();
    void onConfirm();
  }, [onConfirm]);

  const Dialog: ReactElement | null = EXIT_SUPPORTED ? (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch to Server/Guest mode?</AlertDialogTitle>
          <AlertDialogDescription>
            The Nightingale desktop will close and the self-hosted server will start in the
            background, reachable from any device on your LAN at{' '}
            <span className="font-mono text-foreground">http://&lt;this-machine&gt;:8080</span>{' '}
            (and the <span className="font-mono text-foreground">/guest</span> route for QR
            check-ins). You can return to the desktop only by relaunching the desktop
            shortcut.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={switching}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={switching} onClick={handleActionClick}>
            {switching ? 'Switching…' : 'Switch to Server/Guest'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : null;

  return { requestOpen, Dialog };
};
