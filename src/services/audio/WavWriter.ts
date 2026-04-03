import RNFS from 'react-native-fs';

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

function base64ByteLength(b64: string): number {
  const len = b64.length;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (len * 3) / 4 - padding;
}

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
 * Each chunk is decoded independently — no alignment issues.
 */
export async function writePcmToWav(
  chunks: readonly string[],
  outputPath: string,
): Promise<void> {
  let totalBytes = 0;
  for (const chunk of chunks) {
    totalBytes += base64ByteLength(chunk);
  }

  const headerB64 = createWavHeaderBase64(totalBytes);
  await RNFS.writeFile(outputPath, headerB64, 'base64');

  for (const chunk of chunks) {
    await RNFS.appendFile(outputPath, chunk, 'base64');
  }
}
