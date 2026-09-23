/**
 * Minimal RIFF/WAV encoder for Float32 PCM mono audio.
 *
 * The recorder hook collects samples from the existing mic sample
 * stream (see `use-mic-samples`) and hands a Float32Array + the source
 * sample rate to `encodeWav`, which returns a `Blob` ready for upload
 * via `save_recording`. Encoding is intentionally tiny: no resampling,
 * no compression, no metadata — the goal is "playback of the raw mic
 * capture alongside the instrumental track". Future work could mix the
 * instrumental into the WAV before upload; for now the player does the
 * mix in-browser.
 *
 * WAV layout: 44-byte RIFF header + PCM payload, little-endian,
 * 16-bit signed, mono. 16-bit @ 44.1 kHz mono ≈ 88 KB/s, ~16 MB for a
 * 3-minute song; base64-encoded that's ~21 MB, comfortably under the
 * 32 MB default axum body cap.
 */

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Clamp + convert a Float32 in [-1, 1] to a signed 16-bit PCM value.
 * NaN/Inf collapse to 0 so a glitchy mic frame can't poison the file.
 */
function floatToPcm16(sample: number): number {
  if (!Number.isFinite(sample)) {
    return 0;
  }
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/**
 * Encode a Float32Array of mono PCM samples into a WAV-encoded Blob.
 * Throws when the sample rate is non-positive or outside the integer range
 * the WAV header can represent.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`encodeWav: invalid sample rate ${sampleRate}`);
  }

  const rate = Math.round(sampleRate);
  if (rate < 1 || rate > 0xffff) {
    throw new Error(`encodeWav: sample rate ${rate} out of WAV header range`);
  }

  const sampleCount = samples.length;
  const dataBytes = sampleCount * 2; // 16-bit = 2 bytes per sample
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  // RIFF chunk descriptor (12 bytes)
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');

  // fmt sub-chunk (24 bytes)
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size for PCM
  view.setUint16(20, 1, true); // audio format = uncompressed PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * CHANNELS * (BITS_PER_SAMPLE / 8), true); // byte rate
  view.setUint16(32, CHANNELS * (BITS_PER_SAMPLE / 8), true); // block align
  view.setUint16(34, BITS_PER_SAMPLE, true);

  // data sub-chunk (8 byte header + PCM payload)
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = HEADER_BYTES;
  for (let i = 0; i < sampleCount; i++) {
    view.setInt16(offset, floatToPcm16(samples[i]), true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Convert a Blob (assumed to be WAV) into a base64 string. We can't pass
 * `Blob`/`ArrayBuffer` through the existing JSON-only `invoke` channel,
 * so the bridge serialises the audio payload this way. `FileReader`
 * avoids loading the full file into a `Uint8Array` only to immediately
 * encode it again.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('error', () => reject(reader.error ?? new Error('FileReader failed')));
    reader.addEventListener('load', () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result'));
        return;
      }
      // `readAsDataURL` returns `data:<mime>;base64,<payload>` — strip
      // the prefix so the server can `base64::decode` straight onto
      // the WAV bytes.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    });
    reader.readAsDataURL(blob);
  });
}
