import * as RNFS from '@dr.pogodin/react-native-fs';
import { Buffer } from 'buffer';

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function createWavHeaderBase64(dataByteLength: number): string {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);

  const byteRate = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);         // Subchunk1Size (PCM)
  view.setUint16(20, 1, true);          // AudioFormat (PCM = 1)
  view.setUint16(22, NUM_CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataByteLength, true);

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Writes base64-encoded PCM Int16 chunks to a WAV file.
 * Decodes each chunk individually to avoid base64 padding issues when
 * concatenating multiple encoded strings.
 */
export async function writePcmToWav(
  chunks: readonly string[],
  outputPath: string,
): Promise<void> {
  const pcmBuffers = chunks.map(c => Buffer.from(c, 'base64'));
  const totalBytes = pcmBuffers.reduce((sum, b) => sum + b.length, 0);

  const headerB64 = createWavHeaderBase64(totalBytes);
  const headerBuf = Buffer.from(headerB64, 'base64');

  const wav = Buffer.concat([headerBuf, ...pcmBuffers]);
  await RNFS.writeFile(outputPath, wav.toString('base64'), 'base64');
}
