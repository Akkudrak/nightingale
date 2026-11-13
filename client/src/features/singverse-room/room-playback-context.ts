/**
 * SingVerse karaoke rooms: when the playback screen runs inside a room, the
 * room decides what "exit" and "next" mean and receives the singer's score
 * (saved on their SingVerse profile, not in Nightingale's profiles.json).
 * Outside a room the context is null and playback behaves as upstream.
 */

import { createContext, useContext } from 'react';

export type RoomPlayback = {
  /** Shown as the result's "profile": the singer's SingVerse name. */
  singer: string;
  /** The song ended (or was skipped from the result screen) with this score. */
  onFinished: (score: number) => void;
  /** Leave the playback screen: back to the room's lobby. */
  onExit: () => void;
};

export const RoomPlaybackContext = createContext<RoomPlayback | null>(null);

export const useRoomPlayback = (): RoomPlayback | null => useContext(RoomPlaybackContext);
