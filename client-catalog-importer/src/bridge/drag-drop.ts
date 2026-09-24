//! Tauri webview drag-and-drop event bridge.
//!
//! Wraps `@tauri-apps/api/webview`'s `getCurrentWebview().onDragDropEvent`
//! so the React app can subscribe with a single helper and react to
//! the four lifecycle phases (enter, over, leave, drop). The drop
//! itself is consumed by the Rust `drag_drop` module — by the time
//! this `drop` event reaches JS, the Rust worker has already kicked
//! off the import. The frontend only uses these events for visual
//! feedback (the `body.is-dragging` class hook).

import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';

export type DragDropEvent =
  | { type: 'enter' }
  | { type: 'over' }
  | { type: 'leave' }
  | { type: 'drop'; paths: readonly string[] };

export const subscribeToImporterDragDrop = (
  handler: (event: DragDropEvent) => void,
): Promise<UnlistenFn> => {
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'enter') {
      handler({ type: 'enter' });
    } else if (event.payload.type === 'over') {
      handler({ type: 'over' });
    } else if (event.payload.type === 'leave') {
      handler({ type: 'leave' });
    } else {
      handler({ type: 'drop', paths: event.payload.paths });
    }
  });
};
