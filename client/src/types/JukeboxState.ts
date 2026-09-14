// Wire-format type for the `jukebox` WebSocket event emitted by the server.
// Mirrors `client/src-server/src/jukebox.rs::JukeboxState`. The Rust struct
// is `pub(crate)` and not exported via ts-rs, so this is a hand-maintained
// mirror; keep fields in sync if the server adds new ones.
export type JukeboxState = {
  controller: number | null;
  current_song: string | null;
  mic_owner: number | null;
  paused: boolean;
  pitch_hz: number | null;
  position_ms: number;
  rms: number | null;
  score: number;
  theme: string | null;
};
