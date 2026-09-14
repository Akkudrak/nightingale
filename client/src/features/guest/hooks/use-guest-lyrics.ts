import { useQuery } from '@tanstack/react-query';

import { loadLyrics } from '@/bridge/lyrics';
import { loadTranscript } from '@/bridge/playback';
import { linesFromTranscript } from '@/features/lyrics/utils/edit-lyrics';
import { LYRICS } from '@/shared/query-keys';

type GuestLyrics = {
  lines: string[];
  source: 'file' | 'transcript' | 'none';
};

const fetchGuestLyrics = async (fileHash: string): Promise<GuestLyrics> => {
  try {
    const file = await loadLyrics(fileHash);
    if (file && file.lines.length > 0) {
      return { lines: file.lines, source: 'file' };
    }
  } catch {
    // Fall through to the transcript path.
  }
  try {
    const transcript = await loadTranscript(fileHash);
    const lines = linesFromTranscript(transcript)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length > 0) {
      return { lines, source: 'transcript' };
    }
  } catch {
    // No transcript either.
  }
  return { lines: [], source: 'none' };
};

export const useGuestLyrics = (fileHash: string | null) =>
  useQuery({
    queryKey: [...LYRICS, 'guest', fileHash] as const,
    queryFn: () => {
      if (fileHash === null) {
        throw new Error('fileHash required');
      }
      return fetchGuestLyrics(fileHash);
    },
    enabled: fileHash !== null,
    staleTime: 5 * 60 * 1000,
  });
