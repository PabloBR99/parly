// SileroVADService — Silero ONNX-based Voice Activity Detection.
//
// Wraps the native ParlySileroVADDirect module (Kotlin) which runs the Silero
// ONNX model via ONNX Runtime Java API directly — bypassing sherpa-onnx's Vad
// class which SIGABRTs on the QNN build.
//
// Key improvements over energy-based VAD:
//   - Neural network probability vs RMS energy — far fewer false triggers
//   - Handles background noise, taps, and ambient sound gracefully
//   - Faster onset detection: 200ms vs 350ms confirmation window

import { NativeModules } from 'react-native';
import { useAudioLevelStore } from '../../store/audioLevelStore';

const ParlySileroVAD = NativeModules.ParlySileroVADDirect;

export type VADEvent = 'speech_start' | 'speech_end';
type VADCallback = (event: VADEvent) => void;

type InternalState = 'silence' | 'maybe_speech' | 'speech' | 'maybe_silence';

// ── Tuning constants ─────────────────────────────────────────────────────────

/** Silero probability threshold — 0.5 is the recommended default. */
const SPEECH_THRESHOLD = 0.5;

/**
 * Confirmation window for speech onset — shorter than energy VAD (350ms)
 * because Silero's probability is more reliable than RMS.
 */
const SPEECH_ONSET_MS = 200;

/** Silence after speech to end utterance — same as energy VAD. */
const SILENCE_TIMEOUT_MS = 900;

/** Pre-roll: 400ms of audio before detected speech onset. */
const PRE_ROLL_BYTES = 16000 * 2 * 0.4; // 12800 bytes

/** Minimum segment length for meaningful ASR output. */
const MIN_SEGMENT_BYTES = 16000 * 2 * 0.8; // 25600 bytes

// ── Helpers ──────────────────────────────────────────────────────────────────

function base64ByteLength(b64: string): number {
  const len = b64.length;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (len * 3) / 4 - padding;
}

/** Decode base64 Int16 PCM to Float32 array in [-1, 1]. */
function decodeBase64PcmToFloat32Array(base64Pcm: string): number[] {
  const binary = atob(base64Pcm);
  const numSamples = Math.floor(binary.length / 2);
  const samples: number[] = new Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    let sample = lo | (hi << 8);
    if (sample >= 0x8000) sample -= 0x10000;
    samples[i] = sample / 32768;
  }
  return samples;
}

/** Quick RMS for the audio level meter (UI only, not for detection). */
function computeRmsFromSamples(samples: number[]): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const s of samples) sumSquares += s * s;
  return Math.sqrt(sumSquares / samples.length);
}

// ── Service ──────────────────────────────────────────────────────────────────

interface PcmChunk {
  readonly data: string;
  readonly byteLength: number;
}

class SileroVADService {
  private active = false;
  private initialized = false;
  private state: InternalState = 'silence';
  private stateEnteredAt = 0;
  private callbacks: VADCallback[] = [];

  // Ring buffer for pre-roll
  private ringBuffer: PcmChunk[] = [];
  private ringBufferBytes = 0;

  // Pre-roll snapshot
  private preRollChunks: string[] = [];

  // Accumulated speech PCM chunks
  private speechChunks: string[] = [];
  private speechBytes = 0;

  // ── Initialization ──────────────────────────────────────────────────────

  /** Load the Silero ONNX model. Must be called before start(). */
  async load(modelPath: string): Promise<void> {
    if (!ParlySileroVAD) {
      console.warn('[SileroVAD] Native module not available — falling back to energy VAD');
      return;
    }
    try {
      await ParlySileroVAD.initialize(modelPath);
      this.initialized = true;
      console.log('[SileroVAD] Model loaded from', modelPath);
    } catch (e) {
      console.error('[SileroVAD] Failed to load model:', e);
      this.initialized = false;
    }
  }

  get isLoaded(): boolean {
    return this.initialized;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    this.active = true;
    this.reset();
  }

  stop(): void {
    this.active = false;
    useAudioLevelStore.getState().setLevel(0);
    this.reset();
  }

  pause(): void {
    this.active = false;
    useAudioLevelStore.getState().setLevel(0);
  }

  resume(): void {
    this.active = true;
    this.state = 'silence';
    this.ringBuffer = [];
    this.ringBufferBytes = 0;
    this.preRollChunks = [];
    this.speechChunks = [];
    this.speechBytes = 0;
    // Reset native state to avoid stale speech detection from pre-pause audio
    if (this.initialized) {
      ParlySileroVAD.reset().catch(() => {});
    }
  }

  // ── Event subscription ─────────────────────────────────────────────────

  onEvent(cb: VADCallback): () => void {
    this.callbacks.push(cb);
    return () => {
      this.callbacks = this.callbacks.filter(c => c !== cb);
    };
  }

  // ── Core: feed a base64-encoded PCM chunk ──────────────────────────────

  processChunk(base64Pcm: string): void {
    this.updateRingBuffer(base64Pcm);

    if (!this.active) return;

    if (!this.initialized) {
      // Not loaded yet — silently skip
      return;
    }

    // Decode for native VAD + UI level meter
    const samples = decodeBase64PcmToFloat32Array(base64Pcm);
    const rms = computeRmsFromSamples(samples);
    useAudioLevelStore.getState().setLevel(rms * 8);

    // Fire-and-forget to native — the result comes back async
    void this.processChunkAsync(base64Pcm, samples);
  }

  /** Collect accumulated speech audio. Call immediately after 'speech_end'. */
  collectSpeechChunks(): string[] {
    const chunks = this.speechChunks;
    this.speechChunks = [];
    this.speechBytes = 0;
    return chunks;
  }

  /** Release native resources. */
  async release(): Promise<void> {
    this.active = false;
    this.initialized = false;
    if (ParlySileroVAD) {
      await ParlySileroVAD.release().catch(() => {});
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private async processChunkAsync(base64Pcm: string, samples: number[]): Promise<void> {
    try {
      const result = await ParlySileroVAD.acceptWaveform(samples, 16000);
      if (!this.active) return;

      const isSpeech: boolean = result.isSpeechDetected;
      const now = Date.now();
      const chunkBytes = base64ByteLength(base64Pcm);

      this.updateStateMachine(isSpeech, now, base64Pcm, chunkBytes);
    } catch {
      // Native call failed — skip this chunk
    }
  }

  private updateStateMachine(
    isSpeech: boolean,
    now: number,
    base64Pcm: string,
    chunkBytes: number,
  ): void {
    switch (this.state) {
      case 'silence':
        if (isSpeech) {
          this.state = 'maybe_speech';
          this.stateEnteredAt = now;
          this.preRollChunks = this.ringBuffer.map(c => c.data);
          this.speechChunks = [base64Pcm];
          this.speechBytes = chunkBytes;
        }
        break;

      case 'maybe_speech':
        this.speechChunks.push(base64Pcm);
        this.speechBytes += chunkBytes;
        if (!isSpeech) {
          this.state = 'silence';
          this.speechChunks = [];
          this.speechBytes = 0;
          this.preRollChunks = [];
        } else if (now - this.stateEnteredAt >= SPEECH_ONSET_MS) {
          this.state = 'speech';
          this.speechChunks = [...this.preRollChunks, ...this.speechChunks];
          this.speechBytes = 0;
          for (const c of this.speechChunks) {
            this.speechBytes += base64ByteLength(c);
          }
          this.preRollChunks = [];
          this.emit('speech_start');
        }
        break;

      case 'speech':
        this.speechChunks.push(base64Pcm);
        this.speechBytes += chunkBytes;
        if (!isSpeech) {
          this.state = 'maybe_silence';
          this.stateEnteredAt = now;
        }
        break;

      case 'maybe_silence':
        this.speechChunks.push(base64Pcm);
        this.speechBytes += chunkBytes;
        if (isSpeech) {
          this.state = 'speech';
        } else if (now - this.stateEnteredAt >= SILENCE_TIMEOUT_MS) {
          this.state = 'silence';
          if (this.speechBytes >= MIN_SEGMENT_BYTES) {
            this.emit('speech_end');
          } else {
            console.log(`[SileroVAD] Discarding short segment: ${this.speechBytes}B < ${MIN_SEGMENT_BYTES}B`);
            this.speechChunks = [];
            this.speechBytes = 0;
          }
        }
        break;
    }
  }

  private updateRingBuffer(base64Pcm: string): void {
    const byteLength = base64ByteLength(base64Pcm);
    this.ringBuffer.push({ data: base64Pcm, byteLength });
    this.ringBufferBytes += byteLength;

    while (this.ringBufferBytes > PRE_ROLL_BYTES && this.ringBuffer.length > 1) {
      const removed = this.ringBuffer.shift()!;
      this.ringBufferBytes -= removed.byteLength;
    }
  }

  private emit(event: VADEvent): void {
    for (const cb of this.callbacks) {
      cb(event);
    }
  }

  private reset(): void {
    this.state = 'silence';
    this.stateEnteredAt = 0;
    this.ringBuffer = [];
    this.ringBufferBytes = 0;
    this.preRollChunks = [];
    this.speechChunks = [];
    this.speechBytes = 0;
  }
}

export const sileroVADService = new SileroVADService();
