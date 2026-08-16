// audioLevelBus — the one-way pipe from the live microphone to the UI's meters.
//
// A bus and not the conversation store, because a level update lands ~31×/s
// (once per 32 ms VAD frame) and pushing that through Zustand would re-render
// both halves, every turn and every notice thirty-one times a second to move
// seven 2 px bars. Here the orchestrator publishes and the seam wave subscribes
// straight into a Reanimated shared value: one UI-thread write, zero renders.
//
// What is published is a *perceptual* 0..1, never a raw amplitude: frame RMS →
// dBFS → normalised against a fixed window → envelope follower. Loudness is
// logarithmic, so a linear meter sits pinned near zero and then jumps, which is
// what makes cheap visualisers look fake; the follower (fast attack, slow
// release) is what makes it a needle rather than a strobe.

/** Audio covered by one VAD frame (512 samples @ 16 kHz). */
export const FRAME_MS = 32;

// The normalisation window. Fixed, not auto-ranging: adaptive gain here would
// "pump", blooming a quiet room to full scale until silence looks like speech.
// That is a property of what this drives — a meter a person is watching — so it
// held when capture moved to the unprocessed VOICE_RECOGNITION source.
//
// Values come from levels logged on device (silence ~-70 dBFS, speech -35..-20,
// peaks -13) under the old source, so without its gain control the needle may
// simply sit lower. Cosmetic, and worth re-reading off a device log before
// anyone moves these two numbers to chase it.
export const LEVEL_FLOOR_DBFS = -60;
export const LEVEL_CEIL_DBFS = -18;

// Envelope follower time constants. Attack is short enough that a consonant
// lands on the same frame you hear it; release is long enough that the gaps
// *inside* a word don't collapse the wave. Asymmetry is the whole trick.
const ATTACK_MS = 45;
const RELEASE_MS = 240;

// One-pole coefficients for a fixed 32 ms step. The step is the frame's audio
// duration, not wall-clock: a burst of frames arriving in one chunk must
// advance the envelope by the audio they represent, not by the zero
// milliseconds it took to loop over them.
const ATTACK_COEF = 1 - Math.exp(-FRAME_MS / ATTACK_MS);
const RELEASE_COEF = 1 - Math.exp(-FRAME_MS / RELEASE_MS);

/** Below this the tail is snapped to a true zero, so the wave fully settles. */
const SILENCE_EPSILON = 0.002;

export type AudioLevelListener = (level: number) => void;

const listeners = new Set<AudioLevelListener>();
let current = 0;

/** RMS of one PCM frame, normalised to [0, 1] as a fraction of full scale. */
export function frameRms(pcmInt16: Int16Array): number {
  const n = pcmInt16.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcmInt16[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Map a full-scale RMS to a perceptual 0..1 across the calibrated window. */
export function rmsToLevel(rms: number): number {
  if (!(rms > 0)) return 0;
  const dbfs = 20 * Math.log10(rms);
  const t = (dbfs - LEVEL_FLOOR_DBFS) / (LEVEL_CEIL_DBFS - LEVEL_FLOOR_DBFS);
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/**
 * Feed one frame's RMS. Advances the envelope by exactly one frame of audio
 * time and notifies subscribers. Call this only while the microphone is
 * hearing the *room* — never while the phone is playing its own TTS, or the
 * meter would visualise the app's own voice.
 */
export function publishAudioFrame(rms: number): void {
  const target = rmsToLevel(rms);
  const coef = target > current ? ATTACK_COEF : RELEASE_COEF;
  current += (target - current) * coef;
  if (current < SILENCE_EPSILON) current = 0;
  emit();
}

/** Snap to silence immediately — mic closed, paused, or TTS taking the floor. */
export function resetAudioLevel(): void {
  if (current === 0) return;
  current = 0;
  emit();
}

/** Current smoothed level, for late subscribers. */
export function getAudioLevel(): number {
  return current;
}

/**
 * Subscribe to the level. The listener is primed with the current value
 * immediately, so a meter that (re)mounts mid-utterance picks up where the
 * room actually is instead of starting from silence.
 */
export function subscribeAudioLevel(listener: AudioLevelListener): () => void {
  listeners.add(listener);
  deliver(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) {
    deliver(listener);
  }
}

function deliver(listener: AudioLevelListener): void {
  try {
    listener(current);
  } catch {
    // A broken meter must never take down the audio path — or the caller
    // that happened to be subscribing when it broke.
  }
}
