// SileroVadService — on-device Voice Activity Detection via Silero VAD v5.
//
// Runs the silero_vad.onnx model (≈2 MB) via onnxruntime-react-native.
// The model takes 512-sample (32 ms) frames at 16 kHz and outputs a speech
// probability [0, 1] with an internal RNN state that must be carried across
// frames. This service handles the state and fires onSpeechStart / onSpeechEnd
// with a configurable silence hangover so short gaps (breathing, pauses) don't
// fragment an utterance.
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
const SAMPLE_RATE = 16_000;

// Silero VAD v5 state shape: [2, 1, 128] — a single h+c tensor.
const STATE_SIZE = 2 * 1 * 128; // = 256 floats
const STATE_DIMS = [2, 1, 128];

export interface VadConfig {
  /** Probability threshold above which a frame is considered speech (0-1). */
  readonly speechProbThreshold?: number;
  /** How long silence must persist after speech before onSpeechEnd fires (ms). */
  readonly silenceHangoverMs?: number;
}

type Unsubscribe = () => void;

interface VadSubscriber {
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
}

// Minimal ONNX Runtime surface we depend on — lets tests inject a stub.
export interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}
export interface OrtTensor {
  readonly data: Float32Array | BigInt64Array | Int32Array;
}
export type OrtSessionFactory = (modelPath: string) => Promise<OrtSession>;

export class SileroVadService {
  private session: OrtSession | null = null;
  private state: Float32Array = new Float32Array(STATE_SIZE);
  private speaking = false;
  private hangoverTimer: ReturnType<typeof setTimeout> | null = null;
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
  private readonly sessionFactory: OrtSessionFactory;

  constructor(config: VadConfig = {}, sessionFactory?: OrtSessionFactory) {
    this.threshold = config.speechProbThreshold ?? 0.35;
    this.hangoverMs = config.silenceHangoverMs ?? 800;
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

  subscribe(onSpeechStart: () => void, onSpeechEnd: () => void): Unsubscribe {
    const sub: VadSubscriber = { onSpeechStart, onSpeechEnd };
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
      this.clearHangoverTimer();
    }
  }

  destroy(): void {
    this.clearHangoverTimer();
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

      // First-frame sample dump: log raw Int16 values to verify decode path.
      if (this.frameCount === 0) {
        const samples = Array.from(pcmInt16.slice(0, 10)).join(',');
        log.info(`[vad] frame#1 pcm[0..9]=${samples} rms=${frameRms.toFixed(4)}`);
      }

      // Build ONNX tensors. We import onnxruntime-react-native at call time so
      // the module can be mocked in tests without Metro needing it bundled.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ort = require('onnxruntime-react-native') as {
        Tensor: new (type: string, data: unknown, dims: number[]) => OrtTensor;
      };

      // Encode sr=16000 as int64 using Int32Array([low32, high32]) in little-endian.
      // Avoids Hermes BigInt64Array JNI interop issues on Android where BigInt values
      // can silently serialize as 0 through the ORT JNI bridge, causing Silero's
      // conditional sr==16000 branch to evaluate false → 8kHz path → prob≈0.
      const srData = new Int32Array([SAMPLE_RATE, 0]); // [0x00003E80, 0x00000000]

      const feeds: Record<string, OrtTensor> = {
        input: new ort.Tensor('float32', input, [1, VAD_FRAME_SAMPLES]),
        state: new ort.Tensor('float32', new Float32Array(this.state), STATE_DIMS),
        sr: new ort.Tensor('int64', srData, [1]),
      };

      const results = await this.session.run(feeds);

      const prob = (results['output'].data as Float32Array)[0];
      // Copy stateN into a JS-owned buffer so subsequent session.run() calls
      // cannot corrupt the reference via native buffer reuse.
      this.state = new Float32Array(results['stateN'].data as Float32Array);

      // Log raw probability for each of the first 10 frames to confirm model output.
      if (this.frameCount < 10) {
        log.info(`[vad] early frame=${this.frameCount} prob=${prob.toFixed(4)} amp=${frameMaxAbs.toFixed(3)}`);
      }

      this.processProbability(prob);
    } catch (e) {
      log.error('[vad] frame inference error', e instanceof Error ? e : new Error(String(e)));
    }
  }

  private processProbability(prob: number): void {
    this.frameCount++;
    if (prob > this.maxProbWindow) this.maxProbWindow = prob;
    // Log a diagnostic window every 50 frames (~1.6 s) so we can see if
    // audio is flowing and what probabilities the model is producing.
    if (this.frameCount % 50 === 0) {
      log.info(`[vad] frames=${this.frameCount} maxProb=${this.maxProbWindow.toFixed(3)} maxAmp=${this.maxAmpWindow.toFixed(3)} maxRms=${this.maxRmsWindow.toFixed(4)} threshold=${this.threshold} speaking=${this.speaking}`);
      this.maxProbWindow = 0;
      this.maxAmpWindow = 0;
      this.maxRmsWindow = 0;
    }

    const isSpeech = prob >= this.threshold;

    if (isSpeech) {
      this.clearHangoverTimer();
      if (!this.speaking) {
        this.speaking = true;
        this.emit('start');
      }
    } else if (this.speaking && this.hangoverTimer === null) {
      this.hangoverTimer = setTimeout(() => {
        this.hangoverTimer = null;
        this.speaking = false;
        this.emit('end');
      }, this.hangoverMs);
    }
  }

  private clearHangoverTimer(): void {
    if (this.hangoverTimer !== null) {
      clearTimeout(this.hangoverTimer);
      this.hangoverTimer = null;
    }
  }

  private emit(event: 'start' | 'end'): void {
    for (const sub of this.subscribers) {
      try {
        if (event === 'start') sub.onSpeechStart();
        else sub.onSpeechEnd();
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
