/**
 * Subscribes to the live microphone sample stream and accumulates the
 * captured audio into a growable Float32Array. Designed for one-shot
 * use during a karaoke session: the result dialog calls `startRecording`
 * when the user opts to keep a recording, and `stopRecording` returns
 * the captured PCM + the source rate, which the caller feeds to
 * `encodeWav` and ships to the server.
 *
 * The hook does NOT touch the mic capture lifecycle — it piggy-backs on
 * whatever capture is already in flight (the playback mic context owns
 * that). That's deliberate: the user toggles the mic once at the start
 * of the song, the karaoke visor streams frames for pitch scoring, and
 * we quietly siphon a copy for the recording so we never have to
 * reason about double-stream capture.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  microphoneAdapter,
  type MicSampleFrame,
  type MicrophoneAdapter,
} from '@/bridge/microphone';
import { useMicSamples } from '@/features/microphone/hooks/use-mic-samples';

const defaultAdapter = microphoneAdapter;

export type MicRecorderState = 'idle' | 'recording' | 'finalising' | 'error';

export type MicRecorderSnapshot = {
  state: MicRecorderState;
  sampleRate: number;
  durationSecs: number;
  /** Approximate frames captured; useful for the UI without exposing the full PCM. */
  sampleCount: number;
  error: string | null;
};

export type MicRecording = {
  samples: Float32Array;
  sampleRate: number;
  durationSecs: number;
};

const INITIAL_SNAPSHOT: MicRecorderSnapshot = {
  state: 'idle',
  sampleRate: 0,
  durationSecs: 0,
  sampleCount: 0,
  error: null,
};

type InternalBuffer = {
  chunks: Float32Array[];
  totalSamples: number;
  sampleRate: number;
};

/**
 * Track the recorder state without forcing the host to deal with refs.
 *
 * `enabled` is `true` only between `startRecording()` and `stopRecording()`
 * — outside that window the underlying `useMicSamples` hook doesn't
 * subscribe to the mic stream, so we don't waste cycles.
 */
export function useMicRecorder(adapter: MicrophoneAdapter = defaultAdapter) {
  const bufferRef = useRef<InternalBuffer>({
    chunks: [],
    totalSamples: 0,
    sampleRate: 0,
  });
  const startTimeRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<MicRecorderSnapshot>(INITIAL_SNAPSHOT);

  const handleFrame = useCallback((frame: MicSampleFrame) => {
    const buffer = bufferRef.current;
    if (buffer.sampleRate === 0 && frame.sample_rate > 0) {
      buffer.sampleRate = frame.sample_rate;
    }
    // `MicSampleFrame.samples` is `Array<number>` from ts-rs; copy into
    // a real Float32Array for cheap concat later.
    const copy = Float32Array.from(frame.samples);
    buffer.chunks.push(copy);
    buffer.totalSamples += copy.length;
  }, []);

  // Subscribe only while actively recording. The hook ignores the
  // adapter argument — it's threaded through to make tests tractable
  // even though the bridge adapter is a singleton today.
  useMicSamples(handleFrame, snapshot.state === 'recording', adapter);

  useEffect(() => {
    if (snapshot.state !== 'recording') {
      return undefined;
    }
    const id = window.setInterval(() => {
      const buffer = bufferRef.current;
      const elapsed =
        startTimeRef.current === null ? 0 : (performance.now() - startTimeRef.current) / 1000;
      setSnapshot((prev) => ({
        ...prev,
        durationSecs: elapsed,
        sampleRate: buffer.sampleRate,
        sampleCount: buffer.totalSamples,
      }));
    }, 250);
    return () => window.clearInterval(id);
  }, [snapshot.state]);

  const startRecording = useCallback(() => {
    bufferRef.current = { chunks: [], totalSamples: 0, sampleRate: 0 };
    startTimeRef.current = performance.now();
    setSnapshot({ ...INITIAL_SNAPSHOT, state: 'recording' });
  }, []);

  const stopRecording = useCallback((): MicRecording | null => {
    const buffer = bufferRef.current;
    if (buffer.totalSamples === 0 || buffer.sampleRate === 0) {
      setSnapshot({
        ...INITIAL_SNAPSHOT,
        state: 'error',
        error: 'No microphone samples were captured.',
      });
      return null;
    }

    setSnapshot((prev) => ({ ...prev, state: 'finalising' }));

    // Flatten chunks into one contiguous PCM buffer. Karaoke clips
    // run 2–5 minutes; even at 44.1 kHz mono that's < 14M samples,
    // which Float32Array handles trivially.
    const merged = new Float32Array(buffer.totalSamples);
    let offset = 0;
    for (const chunk of buffer.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const durationSecs = merged.length / buffer.sampleRate;
    const recording: MicRecording = {
      samples: merged,
      sampleRate: buffer.sampleRate,
      durationSecs,
    };

    bufferRef.current = { chunks: [], totalSamples: 0, sampleRate: 0 };
    startTimeRef.current = null;
    setSnapshot(INITIAL_SNAPSHOT);
    return recording;
  }, []);

  const cancelRecording = useCallback(() => {
    bufferRef.current = { chunks: [], totalSamples: 0, sampleRate: 0 };
    startTimeRef.current = null;
    setSnapshot(INITIAL_SNAPSHOT);
  }, []);

  return {
    snapshot,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
