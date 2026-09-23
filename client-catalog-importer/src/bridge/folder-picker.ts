//! Native folder picker.
//!
//! Calls `@tauri-apps/plugin-dialog`'s `open({ directory: true })` so
//! users get the OS-native folder chooser without WebView2 friction.
//! Both SetupWizard steps and the `StatusView` "gear" re-entry reuse
//! this helper.

import { open as openDialog } from '@tauri-apps/plugin-dialog';

export const pickFolder = async (title: string): Promise<string | null> => {
  const result = await openDialog({
    directory: true,
    multiple: false,
    title,
  });
  if (Array.isArray(result)) {
    return result[0] ?? null;
  }
  return result;
};
