// Voice Activity Detection — energy-based with ring buffer for pre-roll.
// Detects speech onset/offset from streaming PCM and accumulates audio segments.

export type VADEvent = 'speech_start' | 'speech_end';
type VADCallback = (event: VADEvent) => void;

type InternalState = 'silence' | 'maybe_speech' | 'speech' | 'maybe_silence';

interface PcmChunk {
  readonly data: string;       // base64 PCM
  readonly byteLength: number;
}

// ── Tuning constants ─────────────────────────────────────────────────────────
const SILENCE_THRESHOLD = 0.015;        // RMS below this = silence
const SPEECH_ONSET_MS = 250;            // Sustained energy to confirm speech
const SILENCE_TIMEOUT_MS = 1200;        // Silence after speech to end utterance
const PRE_ROLL_BYTES = 16000 * 2 * 0.4; // 400ms at 16kHz 16-bit mono = 12 800 bytes

// ── Helpers ──────────────────────────────────────────────────────────────────

function base64ByteLength(b64: string): number {
  const len = b64.length;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (len * 3) / 4 - padding;
}

function computeRms(base64Pcm: string): number {
  const binary = atob(base64Pcm);
  const numSamples = Math.floor(binary.length / 2);
  if (numSamples === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < numSamples; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    let sample = lo | (hi << 8);
    if (sample >= 0x8000) sample -= 0x10000; // unsigned → signed Int16
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }

  return Math.sqrt(sumSquares / numSamples);
}

// ── Service ──────────────────────────────────────────────────────────────────

class VADService {
  private active = false;
  private state: InternalState = 'silence';
  private stateEnteredAt = 0;
  private callbacks: VADCallback[] = [];

  // Ring buffer — always holds the last PRE_ROLL_BYTES of audio
  private ringBuffer: PcmChunk[] = [];
  private ringBufferBytes = 0;

  // Pre-roll snapshot (captured on silence → maybe_speech transition)
  private preRollChunks: string[] = [];

  // Accumulated speech PCM chunks (onset through offset)
  private speechChunks: string[] = [];

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    this.active = true;
    this.reset();
  }

  stop(): void {
    this.active = false;
    this.reset();
  }

  /** Pause detection (e.g., during TTS) without destroying state */
  pause(): void {
    this.active = false;
  }

  /** Resume detection — clears buffers to avoid processing stale/echo audio */
  resume(): void {
    this.active = true;
    this.state = 'silence';
    this.ringBuffer = [];
    this.ringBufferBytes = 0;
    this.preRollChunks = [];
    this.speechChunks = [];
  }

  // ── Event subscription ───────────────────────────────────────────────────

  onEvent(cb: VADCallback): () => void {
    this.callbacks.push(cb);
    return () => {
      this.callbacks = this.callbacks.filter(c => c !== cb);
    };
  }

  // ── Core: feed a base64-encoded PCM chunk ────────────────────────────────

  processChunk(base64Pcm: string): void {
    // Always keep the ring buffer up to date (even when paused)
    this.updateRingBuffer(base64Pcm);

    if (!this.active) return;

    const rms = computeRms(base64Pcm);
    const isSpeech = rms > SILENCE_THRESHOLD;
    const now = Date.now();

    switch (this.state) {
      case 'silence':
        if (isSpeech) {
          this.state = 'maybe_speech';
          this.stateEnteredAt = now;
          // Snapshot ring buffer (before current chunk) as pre-roll
          this.preRollChunks = this.ringBuffer.map(c => c.data);
          this.speechChunks = [base64Pcm];
        }
        break;

      case 'maybe_speech':
        this.speechChunks.push(base64Pcm);
        if (!isSpeech) {
          // False alarm
          this.state = 'silence';
          this.speechChunks = [];
          this.preRollChunks = [];
        } else if (now - this.stateEnteredAt >= SPEECH_ONSET_MS) {
          // Confirmed speech — prepend pre-roll
          this.state = 'speech';
          this.speechChunks = [...this.preRollChunks, ...this.speechChunks];
          this.preRollChunks = [];
          this.emit('speech_start');
        }
        break;

      case 'speech':
        this.speechChunks.push(base64Pcm);
        if (!isSpeech) {
          this.state = 'maybe_silence';
          this.stateEnteredAt = now;
        }
        break;

      case 'maybe_silence':
        this.speechChunks.push(base64Pcm);
        if (isSpeech) {
          // Speech resumed (mid-sentence pause)
          this.state = 'speech';
        } else if (now - this.stateEnteredAt >= SILENCE_TIMEOUT_MS) {
          // Confirmed end of utterance
          this.state = 'silence';
          this.emit('speech_end');
          // Caller must collect chunks before next processChunk call
        }
        break;
    }
  }

  /** Collect accumulated speech audio. Call immediately after 'speech_end'. */
  collectSpeechChunks(): string[] {
    const chunks = this.speechChunks;
    this.speechChunks = [];
    return chunks;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

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
  }
}

export const vadService = new VADService();
