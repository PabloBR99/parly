import * as RNFS from '@dr.pogodin/react-native-fs';

const SRC_RATE = 16000;
const DST_RATE = 24000;
const MAX_VOICE_REF_SEC = 5;

/**
 * Read a 16kHz mono Int16LE WAV file, decode PCM, resample to 24kHz,
 * and trim to MAX_VOICE_REF_SEC seconds. Returns Float32 [-1, 1] at 24kHz.
 *
 * Used to build a voice cloning reference from the speaker's own PTT audio.
 */
export async function readWavAsVoiceRef(wavPath: string): Promise<Float32Array> {
  const base64 = await RNFS.readFile(wavPath, 'base64');
  return decodeWavBase64(base64);
}

/** Decode a base64 WAV string (16kHz mono Int16LE) → Float32 at 24kHz. */
export function decodeWavBase64(base64: string): Float32Array {
  const binary = atob(base64);
  const WAV_HEADER = 44;
  const maxSamples16k = SRC_RATE * MAX_VOICE_REF_SEC;
  const rawSamples = Math.floor((binary.length - WAV_HEADER) / 2);
  const numSamples = Math.min(rawSamples, maxSamples16k);

  if (numSamples <= 0) return new Float32Array(0);

  const pcm16k = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const lo = binary.charCodeAt(WAV_HEADER + i * 2);
    const hi = binary.charCodeAt(WAV_HEADER + i * 2 + 1);
    let s = lo | (hi << 8);
    if (s >= 0x8000) s -= 0x10000;
    pcm16k[i] = s / 32768;
  }

  return resampleLinear(pcm16k, SRC_RATE, DST_RATE);
}

/** Linear interpolation resample between arbitrary sample rates. */
function resampleLinear(
  input: Float32Array,
  srcRate: number,
  dstRate: number,
): Float32Array {
  if (srcRate === dstRate) return input;
  const ratio = srcRate / dstRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcPos = i * ratio;
    const lo = Math.floor(srcPos);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcPos - lo;
    output[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return output;
}
