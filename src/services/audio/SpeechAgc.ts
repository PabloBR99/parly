// SpeechAgc — a slow, speech-gated level normaliser in front of the transcriber.
//
// Capture moved from VOICE_COMMUNICATION to VOICE_RECOGNITION because the
// former's processing hurt the transcript (its suppressor deleted quiet speech,
// its AGC drove ordinary speech to full scale). The latter offers neither, so
// the level reaching Voxtral is whatever the room gives it — and the room is a
// phone flat on a table between two people, where a soft speaker can land 25 dB
// below a loud one.
//
// Not oversold: digital gain does NOT improve SNR, it lifts noise and speech
// alike. It only puts the samples in the range the recogniser's front end
// expects, which matters when a talker is far enough below it to lose
// resolution. Whether it moves WER on this pipeline is open, and answerable —
// `scripts/voxtral-wer-bench.mjs --agc on|off`. Until then, insurance.
//
// Three properties keep it from repeating the old source's mistakes:
//   1. It adapts only on speech-loud frames. Gain that chases silence blooms in
//      a quiet room and ducks the first word after it — audible "pumping".
//   2. Slow up (~1.2 s), fast down. Too much gain is unrecoverable (a clipped
//      sample has lost its shape); too little is merely a quiet transcript.
//   3. It never clips: per-chunk gain is capped to keep that chunk's own peak
//      inside full scale, so the limiter cannot be overrun.
//
// It sits ONLY in front of Voxtral. The VAD and the seam wave keep raw samples:
// their thresholds are calibrated against the room, and a meter with automatic
// gain is not a meter.

/** Where speech should sit, as RMS dBFS. Comfortably below the peaks a
 *  conversational voice throws (~12-15 dB above its own RMS), so a normalised
 *  sentence still has room for its own consonants. */
const TARGET_DBFS = -21;
/** Ceiling on boost. Beyond this a distant talker is not being helped, they
 *  are being amplified along with the room they are distant in. */
const MAX_GAIN_DB = 15;
/** Floor on cut. Present for the loud near talker, not as a volume policy. */
const MIN_GAIN_DB = -6;
/** Below this a frame is room tone, a door, a chair — not a voice to level
 *  against, so the gain holds where it was. Set below the levels measured on
 *  device (silence ~-70 dBFS, speech -35..-20) and then lower again, since
 *  those came off the old source with its gain control on. A floor that ignores
 *  a soft talker across a table turns this off for the person it is for. */
const SPEECH_FLOOR_DBFS = -55;
/** Time constants: slow up, fast down. See property 2 above. */
const GAIN_UP_MS = 1_200;
const GAIN_DOWN_MS = 180;
/** Peak ceiling in sample units, a hair below full scale. */
const PEAK_LIMIT = 32_000;
/** Gains inside this band are indistinguishable from none, and skipping them
 *  lets an already well-levelled chunk pass through without being copied. */
const BYPASS_DB = 0.3;

const SAMPLE_RATE = 16_000;

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export class SpeechAgc {
  /** Current gain in dB — the thing that moves slowly. */
  private gainDb = 0;
  /** Gain actually applied to the last sample of the previous chunk, so the
   *  ramp inside the next chunk starts where the audio actually left off
   *  rather than jumping. */
  private appliedLinear = 1;
  private lastInputDbfs = -Infinity;

  /** Level of the most recent chunk, before any gain — the honest reading of
   *  what the microphone is hearing. `-Infinity` until the first chunk. */
  get inputDbfs(): number {
    return this.lastInputDbfs;
  }

  /** Gain currently being applied, in dB. */
  get currentGainDb(): number {
    return this.gainDb;
  }

  /** Forget everything. Called whenever capture starts, so one conversation's
   *  gain never lands on the first word of the next. */
  reset(): void {
    this.gainDb = 0;
    this.appliedLinear = 1;
    this.lastInputDbfs = -Infinity;
  }

  /**
   * Level one chunk. Returns the samples to send onward — the input array
   * itself when nothing needed doing, so the common case allocates nothing and
   * the caller must treat the result as read-only either way.
   */
  process(pcm: Int16Array): Int16Array {
    const n = pcm.length;
    if (n === 0) return pcm;

    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const s = pcm[i];
      sumSquares += s * s;
      const abs = s < 0 ? -s : s;
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(sumSquares / n) / 32768;
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    this.lastInputDbfs = dbfs;

    // Adapt only on speech-loud frames (property 1).
    if (dbfs > SPEECH_FLOOR_DBFS) {
      const desiredDb = Math.min(MAX_GAIN_DB, Math.max(MIN_GAIN_DB, TARGET_DBFS - dbfs));
      const chunkMs = (n / SAMPLE_RATE) * 1_000;
      const tau = desiredDb < this.gainDb ? GAIN_DOWN_MS : GAIN_UP_MS;
      const coef = 1 - Math.exp(-chunkMs / tau);
      this.gainDb += (desiredDb - this.gainDb) * coef;
    }

    // Cap this chunk's gain at whatever keeps its own peak inside full scale
    // (property 3). The cap applies to the chunk, not to the running gain: a
    // single loud syllable should not undo a minute of levelling.
    let targetLinear = dbToLinear(this.gainDb);
    if (peak > 0) {
      const ceiling = PEAK_LIMIT / peak;
      if (targetLinear > ceiling) targetLinear = ceiling;
    }

    const startLinear = this.appliedLinear;
    this.appliedLinear = targetLinear;

    // Nothing worth doing: gain is ~1 at both ends of the chunk.
    if (
      Math.abs(20 * Math.log10(startLinear)) < BYPASS_DB &&
      Math.abs(20 * Math.log10(targetLinear)) < BYPASS_DB
    ) {
      return pcm;
    }

    // Ramp across the chunk rather than stepping at its boundary — a gain that
    // changes discontinuously puts a click in the audio, and a click is a
    // consonant as far as an acoustic model is concerned.
    const out = new Int16Array(n);
    const step = n > 1 ? (targetLinear - startLinear) / (n - 1) : 0;
    for (let i = 0; i < n; i++) {
      const scaled = pcm[i] * (startLinear + step * i);
      out[i] = scaled > PEAK_LIMIT ? PEAK_LIMIT : scaled < -PEAK_LIMIT ? -PEAK_LIMIT : scaled | 0;
    }
    return out;
  }
}
