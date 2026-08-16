// pcm — base64 ⇄ 16-bit PCM, without leaning on platform globals.
//
// The capture library hands us base64 and Voxtral wants base64, so for most of
// this app's life nothing ever had to decode it twice: the VAD decoded, the
// transcriber forwarded the string untouched. Level normalisation (SpeechAgc)
// changes that — the samples have to be read, scaled and written back — so the
// decode moved here where both consumers share one pass over the chunk.
//
// Why not `atob`/`btoa`: `atob` happens to exist in React Native and `btoa`'s
// availability varies with the runtime's polyfill set. A 40-line table lookup
// is not worth a platform question in the audio path, and it also means the
// same code runs under Jest and under Node in the bench script.
//
// Endianness: the sample bytes are read as the platform's native order, which
// is little-endian everywhere this app runs and matches the `pcm_s16le` we
// declare to Voxtral. This assumption predates this file (the VAD's decode made
// it too); it is written down here because it now has one home.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup, byte value → 6-bit value; -1 for anything not in the set. */
const INVERSE = (() => {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

const EMPTY = new Int16Array(0);

/** Decode a base64 PCM chunk into samples. Truncated or malformed input
 *  yields whatever whole samples could be read, never a throw — a bad chunk
 *  must cost a chunk, not the turn. */
export function decodePcm16(base64: string): Int16Array {
  const len = base64.length;
  if (len < 4) return EMPTY;

  // Upper bound; the real count comes out of the loop, since padding and any
  // stray character both shorten it.
  const bytes = new Uint8Array((len >> 2) * 3 + 3);
  let out = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const v = INVERSE[base64.charCodeAt(i) & 0xff];
    if (v < 0) continue; // '=', whitespace, anything unexpected
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (acc >> bits) & 0xff;
    }
  }

  const samples = out >> 1;
  if (samples === 0) return EMPTY;
  return new Int16Array(bytes.buffer, 0, samples);
}

/** Encode PCM samples back to base64 for the wire. */
export function encodePcm16(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = bytes.length;
  const parts: string[] = [];
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const triple = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    parts.push(
      ALPHABET[(triple >> 18) & 63] +
        ALPHABET[(triple >> 12) & 63] +
        ALPHABET[(triple >> 6) & 63] +
        ALPHABET[triple & 63],
    );
  }
  const remaining = n - i;
  if (remaining === 1) {
    const t = bytes[i] << 16;
    parts.push(`${ALPHABET[(t >> 18) & 63]}${ALPHABET[(t >> 12) & 63]}==`);
  } else if (remaining === 2) {
    const t = (bytes[i] << 16) | (bytes[i + 1] << 8);
    parts.push(
      `${ALPHABET[(t >> 18) & 63]}${ALPHABET[(t >> 12) & 63]}${ALPHABET[(t >> 6) & 63]}=`,
    );
  }
  return parts.join('');
}
