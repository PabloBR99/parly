// SileroVadService — on-device Voice Activity Detection via Silero VAD v5.
//
// Runs the silero_vad.onnx model (≈2 MB) via onnxruntime-react-native.
// The model takes 512-sample (32 ms) frames at 16 kHz and outputs a speech
// probability [0, 1] with an internal RNN state that must be carried across
// frames. This service handles the state and fires onSpeechStart / onSpeechEnd
// with a configurable silence hangover so short gaps (breathing, pauses) don't
// fragment an utterance.
//
// Endpointing is two-stage. `onSpeechPause` fires early (pauseHintMs) and
// `onSpeechEnd` late (silenceHangoverMs). Silence alone is weak evidence that
// someone finished talking — strong enough only after a long wait, which is
// why the hangover is the largest fixed latency in hands-free. The pause hint
// exists so a subscriber holding better evidence (a transcript that just
// closed a sentence) can end the turn without paying for the hangover, while
// anything ambiguous still waits it out.
//
// Setup:
//   1. `npm install onnxruntime-react-native`
//   2. Download silero_vad.onnx into:
//        android/app/src/main/assets/silero_vad.onnx   (Android)
//        ios/silero_vad.onnx  (add to Xcode target)
//   3. On Android, the model is copied to DocumentDirectoryPath on first
//      initialize() so ONNX Runtime can open it from the file system.
//
// Plan B (if ONNX is too heavy for CMF Phone 1):
//   Replace this class with a react-native-webrtc-vad wrapper — same interface,
//   smaller binary (~500 KB), lower accuracy. Caller code is unchanged.

import { log } from '../log/logStore';
import { Platform } from 'react-native';

/** Number of PCM samples per frame. 512 @ 16 kHz = 32 ms. */
export const VAD_FRAME_SAMPLES = 512;

// Silero VAD v5 state shape: [2, 1, 128] — a single h+c tensor.
const STATE_SIZE = 2 * 1 * 128; // = 256 floats
const STATE_DIMS = [2, 1, 128];

export interface VadConfig {
  /** Probability threshold above which a frame is considered speech (0-1). */
  readonly speechProbThreshold?: number;
  /** How long silence must persist after speech before onSpeechEnd fires (ms). */
  readonly silenceHangoverMs?: number;
  /**
   * How long silence must persist before `onSpeechPause` fires (ms) — an
   * early, non-committal "they might have finished" hint, emitted well before
   * the full hangover. The hangover is a blunt instrument: it has to be long
   * enough to survive a mid-sentence breath, which makes it dead air on the
   * front of every single response. The pause hint lets a listener that has
   * BETTER evidence than silence — a transcript that just closed a sentence —
   * end the turn early, while everyone else still waits out the hangover.
   * Must be shorter than the hangover; ignored otherwise.
   */
  readonly pauseHintMs?: number;
  /**
   * RMS energy threshold for energy-based speech detection (0-1). When > 0,
   * a frame is considered speech if EITHER the model prob exceeds
   * speechProbThreshold OR the RMS exceeds this value. Acts as a fallback when
   * the ONNX model produces near-zero probabilities despite real audio.
   * Default 0.05 (observed speech RMS ≈ 0.22, silence ≈ 0.0003 on CMF Phone 1).
   * Set to 0 to disable energy fallback and rely solely on model probability.
   */
  readonly energySpeechThreshold?: number;
}

type Unsubscribe = () => void;

interface VadSubscriber {
  onSpeechStart: () => void;
  /** `lastSpeechAt` is when the final speech frame was seen — the instant the
   *  room actually went quiet, not when the hangover expired. Every honest
   *  latency measurement starts there. */
  onSpeechEnd: (lastSpeechAt: number) => void;
  onSpeechPause?: (lastSpeechAt: number) => void;
}

// Minimal ONNX Runtime surface we depend on — lets tests inject a stub.
export interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}
export interface OrtTensor {
  readonly data: Float32Array | BigInt64Array | Int32Array;
}
export type OrtSessionFactory = (modelPath: string) => Promise<OrtSession>;

// onnxruntime-react-native and the constant sample-rate buffer are resolved
// once and cached at module scope. The inference path runs ≈31×/s; re-running
// require() and re-allocating the sr tensor on every frame is pure waste in the
// hottest loop in the app. Lazy so Jest can mock the module before first use.
type OrtModule = {
  Tensor: new (type: string, data: unknown, dims: number[]) => OrtTensor;
};
let ortModule: OrtModule | null = null;
function getOrt(): OrtModule {
  if (!ortModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ortModule = require('onnxruntime-react-native') as OrtModule;
  }
  return ortModule;
}
// sr=16000 as int64. Constant model input (read-only), so one shared buffer is
// safe to reuse across every run. The BigInt literal avoids the Hermes BigInt()
// JNI corruption + DataView aliasing issues seen in earlier revisions.
const SR_DATA = new BigInt64Array([16000n]);

export class SileroVadService {
  private session: OrtSession | null = null;
  private state: Float32Array = new Float32Array(STATE_SIZE);
  private speaking = false;
  private hangoverTimer: ReturnType<typeof setTimeout> | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSpeechAt = 0;
  private active = true;
  private subscribers: VadSubscriber[] = [];
  private inferenceRunning = false;
  private inferenceQueue: Int16Array[] = [];
  private initialized = false;
  private frameCount = 0;
  private maxProbWindow = 0;
  private maxAmpWindow = 0;
  private maxRmsWindow = 0;

  private readonly threshold: number;
  private readonly hangoverMs: number;
  private readonly pauseHintMs: number;
  private readonly energyThreshold: number;
  private readonly sessionFactory: OrtSessionFactory;

  constructor(config: VadConfig = {}, sessionFactory?: OrtSessionFactory) {
    this.threshold = config.speechProbThreshold ?? 0.08;
    this.hangoverMs = config.silenceHangoverMs ?? 800;
    this.pauseHintMs = config.pauseHintMs ?? 0;
    this.energyThreshold = config.energySpeechThreshold ?? 0.05;
    this.sessionFactory = sessionFactory ?? defaultOrtSessionFactory;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const modelPath = await resolveModelPath('silero_vad.onnx');
      this.session = await this.sessionFactory(modelPath);
      this.initialized = true;
      log.info('[vad] Silero model loaded');
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      log.error('[vad] initialization failed', err);
      throw err;
    }
  }

  /**
   * Feed one 512-sample frame. Frames that don't match VAD_FRAME_SAMPLES are
   * silently dropped. Runs inference asynchronously; frames are queued to
   * prevent concurrent ONNX calls (which would corrupt state tensors).
   */
  feedFrame(pcmInt16: Int16Array): void {
    if (!this.initialized || !this.session || !this.active) return;
    if (pcmInt16.length !== VAD_FRAME_SAMPLES) return;

    this.inferenceQueue.push(new Int16Array(pcmInt16)); // copy to own buffer
    if (!this.inferenceRunning) {
      void this.drainQueue();
    }
  }

  subscribe(
    onSpeechStart: () => void,
    onSpeechEnd: (lastSpeechAt: number) => void,
    onSpeechPause?: (lastSpeechAt: number) => void,
  ): Unsubscribe {
    const sub: VadSubscriber = { onSpeechStart, onSpeechEnd, onSpeechPause };
    this.subscribers.push(sub);
    return () => {
      this.subscribers = this.subscribers.filter(s => s !== sub);
    };
  }

  /** Gate VAD activity. When false, speech events are suppressed (used during
   *  TTS playback to prevent the device from triggering on its own audio). */
  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.clearSilenceTimers();
    }
  }

  /**
   * Close the current utterance from the outside, without emitting an end
   * event. A subscriber that acted on `onSpeechPause` has already taken the
   * turn; this cancels the hangover that would otherwise fire a second,
   * duplicate ending, and re-arms the detector so the next speaker still
   * produces an `onSpeechStart`.
   */
  endUtterance(): void {
    this.clearSilenceTimers();
    this.speaking = false;
  }

  /** Reset the RNN state and speaking flag without destroying the ONNX session.
   *  Call between HF sessions to prevent stale state from a previous run
   *  affecting speech detection in the new session. */
  resetState(): void {
    this.clearSilenceTimers();
    this.state = new Float32Array(STATE_SIZE);
    this.speaking = false;
    this.frameCount = 0;
    this.maxProbWindow = 0;
    this.maxAmpWindow = 0;
    this.maxRmsWindow = 0;
    this.inferenceQueue = [];
  }

  destroy(): void {
    this.clearSilenceTimers();
    this.subscribers = [];
    this.session = null;
    this.initialized = false;
    this.speaking = false;
    this.inferenceQueue = [];
    this.inferenceRunning = false;
    this.state = new Float32Array(STATE_SIZE);
    this.frameCount = 0;
    this.maxProbWindow = 0;
    this.maxAmpWindow = 0;
    this.maxRmsWindow = 0;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async drainQueue(): Promise<void> {
    this.inferenceRunning = true;
    while (this.inferenceQueue.length > 0) {
      const frame = this.inferenceQueue.shift();
      if (frame) await this.runFrame(frame);
    }
    this.inferenceRunning = false;
  }

  private async runFrame(pcmInt16: Int16Array): Promise<void> {
    if (!this.session) return;
    try {
      // Normalise Int16 → Float32 in [-1, 1].
      const input = new Float32Array(VAD_FRAME_SAMPLES);
      let frameMaxAbs = 0;
      let rmsSum = 0;
      for (let i = 0; i < VAD_FRAME_SAMPLES; i++) {
        input[i] = pcmInt16[i] / 32768.0;
        const abs = Math.abs(input[i]);
        if (abs > frameMaxAbs) frameMaxAbs = abs;
        rmsSum += input[i] * input[i];
      }
      const frameRms = Math.sqrt(rmsSum / VAD_FRAME_SAMPLES);
      if (frameMaxAbs > this.maxAmpWindow) this.maxAmpWindow = frameMaxAbs;
      if (frameRms > this.maxRmsWindow) this.maxRmsWindow = frameRms;

      const ort = getOrt();
      const feeds: Record<string, OrtTensor> = {
        input: new ort.Tensor('float32', input, [1, VAD_FRAME_SAMPLES]),
        state: new ort.Tensor('float32', new Float32Array(this.state), STATE_DIMS),
        sr: new ort.Tensor('int64', SR_DATA, [1]),
      };

      const results = await this.session.run(feeds);

      const prob = (results['output'].data as Float32Array)[0];
      // Copy stateN into a JS-owned buffer so subsequent session.run() calls
      // cannot corrupt the reference via native buffer reuse.
      const stateNRaw = results['stateN'].data as Float32Array;
      this.state = new Float32Array(stateNRaw);

      this.processProbability(prob, frameRms);
    } catch (e) {
      log.error('[vad] frame inference error', e instanceof Error ? e : new Error(String(e)));
    }
  }

  private processProbability(prob: number, frameRms: number): void {
    this.frameCount++;
    if (prob > this.maxProbWindow) this.maxProbWindow = prob;
    if (this.frameCount % 50 === 0) {
      log.info(`[vad] frames=${this.frameCount} maxProb=${this.maxProbWindow.toFixed(3)} maxAmp=${this.maxAmpWindow.toFixed(3)} maxRms=${this.maxRmsWindow.toFixed(4)} threshold=${this.threshold} energyThr=${this.energyThreshold} speaking=${this.speaking}`);
      this.maxProbWindow = 0;
      this.maxAmpWindow = 0;
      this.maxRmsWindow = 0;
    }

    const isModelSpeech = prob >= this.threshold;
    const isEnergySpeech = this.energyThreshold > 0 && frameRms >= this.energyThreshold;
    const isSpeech = isModelSpeech || isEnergySpeech;

    if (isSpeech) {
      this.lastSpeechAt = Date.now();
      this.clearSilenceTimers();
      if (!this.speaking) {
        this.speaking = true;
        this.emit('start', this.lastSpeechAt);
      }
    } else if (this.speaking && this.hangoverTimer === null) {
      // Both timers are armed from the same instant and cancelled together by
      // the next speech frame, so a mid-sentence breath costs nothing: the
      // pause hint is a question ("are they done?"), the hangover is the
      // answer of last resort.
      const since = this.lastSpeechAt;
      if (this.pauseHintMs > 0 && this.pauseHintMs < this.hangoverMs) {
        this.pauseTimer = setTimeout(() => {
          this.pauseTimer = null;
          this.emit('pause', since);
        }, this.pauseHintMs);
      }
      this.hangoverTimer = setTimeout(() => {
        this.hangoverTimer = null;
        this.clearPauseTimer();
        this.speaking = false;
        this.emit('end', since);
      }, this.hangoverMs);
    }
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer !== null) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
  }

  private clearSilenceTimers(): void {
    this.clearPauseTimer();
    if (this.hangoverTimer !== null) {
      clearTimeout(this.hangoverTimer);
      this.hangoverTimer = null;
    }
  }

  private emit(event: 'start' | 'pause' | 'end', lastSpeechAt: number): void {
    for (const sub of this.subscribers) {
      try {
        if (event === 'start') sub.onSpeechStart();
        else if (event === 'pause') sub.onSpeechPause?.(lastSpeechAt);
        else sub.onSpeechEnd(lastSpeechAt);
      } catch (e) {
        log.error('[vad] subscriber error', e instanceof Error ? e : new Error(String(e)));
      }
    }
  }
}

// ── Default ONNX session factory ─────────────────────────────────────────────

async function defaultOrtSessionFactory(modelPath: string): Promise<OrtSession> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ort = require('onnxruntime-react-native') as {
    InferenceSession: { create: (path: string) => Promise<OrtSession> };
  };
  return ort.InferenceSession.create(modelPath);
}

async function resolveModelPath(assetName: string): Promise<string> {
  // On Android, bundle assets cannot be opened directly by ONNX Runtime — we
  // copy them to the document directory on first launch.
  // On iOS, the model is in the main bundle and can be referenced directly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RNFS = require('@dr.pogodin/react-native-fs') as {
    DocumentDirectoryPath: string;
    MainBundlePath: string;
    exists: (path: string) => Promise<boolean>;
    copyFileAssets: (src: string, dest: string) => Promise<void>;
    copyFile: (src: string, dest: string) => Promise<void>;
  };

  if (Platform.OS === 'ios') {
    return `${RNFS.MainBundlePath}/${assetName}`;
  }

  const destPath = `${RNFS.DocumentDirectoryPath}/${assetName}`;
  const exists = await RNFS.exists(destPath);
  if (!exists) {
    await RNFS.copyFileAssets(assetName, destPath);
    log.info(`[vad] model copied to ${destPath}`);
  }
  return destPath;
}
