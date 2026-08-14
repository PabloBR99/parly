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
  /** Speech came back after a pause hint — whatever the hint set in motion
   *  was about an utterance that is not over. Only fires after a hint. */
  onSpeechResume?: () => void;
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
  private pauseHintEmitted = false;
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

  /**
   * Get the model ready, or decide to live without it. Never throws: the
   * caller is a speaker turning hands-free on, and the answer to "the model is
   * unavailable" is a VAD listening on energy, not a dead feature.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Claimed before the FIRST native call, not just before the model load.
    // The first version of this guard staked the claim after the asset had
    // been copied out of the APK — and a device then died inside that copy,
    // upstream of the claim, so every launch walked into it again. Everything
    // from here to "Silero model loaded" is native work that can end the
    // process with nothing to catch and nothing to log; the whole stretch is
    // what the claim has to cover.
    if (!(await claimModelLoad())) {
      log.warn(
        '[vad] skipping the model — the previous attempt never came back, ' +
        'so hands-free is listening on energy alone',
      );
      this.session = null;
      this.initialized = true;
      return;
    }

    try {
      const modelPath = await withDeadline(resolveModelPath('silero_vad.onnx'));
      log.info('[vad] model ready — creating ONNX session');
      this.session = await withDeadline(this.sessionFactory(modelPath));
      await clearModelLoadClaim();
      log.info('[vad] Silero model loaded');
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // A deadline means something native stopped answering — the same shape
      // as whatever has been taking the process down here, so the claim stays
      // standing and the next launch walks around it. A plain failure came
      // back on its own and earns a retry.
      if (err.name !== DEADLINE) await clearModelLoadClaim();
      this.session = null;
      log.error('[vad] model unavailable — listening on energy alone', err);
    }
    this.initialized = true;
  }

  /**
   * Feed one 512-sample frame. Frames that don't match VAD_FRAME_SAMPLES are
   * silently dropped. Runs inference asynchronously; frames are queued to
   * prevent concurrent ONNX calls (which would corrupt state tensors).
   */
  feedFrame(pcmInt16: Int16Array): void {
    // No session is not the same as no VAD: the energy path below needs no
    // model, and on hardware where the model returns near-zero for real speech
    // it is already the thing taking every turn.
    if (!this.initialized || !this.active) return;
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
    onSpeechResume?: () => void,
  ): Unsubscribe {
    const sub: VadSubscriber = { onSpeechStart, onSpeechEnd, onSpeechPause, onSpeechResume };
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
    this.pauseHintEmitted = false;
    this.speaking = false;
  }

  /** Reset the RNN state and speaking flag without destroying the ONNX session.
   *  Call between HF sessions to prevent stale state from a previous run
   *  affecting speech detection in the new session. */
  resetState(): void {
    this.clearSilenceTimers();
    this.pauseHintEmitted = false;
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
    this.pauseHintEmitted = false;
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

      // Without a model there is no probability to have — 0 lets the energy
      // threshold in processProbability() decide on its own.
      let prob = 0;
      if (this.session) {
        const ort = getOrt();
        const feeds: Record<string, OrtTensor> = {
          input: new ort.Tensor('float32', input, [1, VAD_FRAME_SAMPLES]),
          state: new ort.Tensor('float32', new Float32Array(this.state), STATE_DIMS),
          sr: new ort.Tensor('int64', SR_DATA, [1]),
        };

        const results = await this.session.run(feeds);

        prob = (results['output'].data as Float32Array)[0];
        // Copy stateN into a JS-owned buffer so subsequent session.run() calls
        // cannot corrupt the reference via native buffer reuse.
        const stateNRaw = results['stateN'].data as Float32Array;
        this.state = new Float32Array(stateNRaw);
      }

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
      if (this.pauseHintEmitted) {
        this.pauseHintEmitted = false;
        this.emit('resume', this.lastSpeechAt);
      }
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
          this.pauseHintEmitted = true;
          this.emit('pause', since);
        }, this.pauseHintMs);
      }
      this.hangoverTimer = setTimeout(() => {
        this.hangoverTimer = null;
        this.clearPauseTimer();
        this.pauseHintEmitted = false;
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

  private emit(event: 'start' | 'pause' | 'resume' | 'end', lastSpeechAt: number): void {
    for (const sub of this.subscribers) {
      try {
        if (event === 'start') sub.onSpeechStart();
        else if (event === 'pause') sub.onSpeechPause?.(lastSpeechAt);
        else if (event === 'resume') sub.onSpeechResume?.();
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

interface Fs {
  DocumentDirectoryPath: string;
  MainBundlePath: string;
  exists: (path: string) => Promise<boolean>;
  copyFileAssets: (src: string, dest: string) => Promise<void>;
  copyFile: (src: string, dest: string) => Promise<void>;
  moveFile?: (src: string, dest: string) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
  stat?: (path: string) => Promise<{ size: number | string }>;
  writeFile?: (path: string, contents: string, encoding: string) => Promise<void>;
}

function fs(): Fs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@dr.pogodin/react-native-fs') as Fs;
}

/** How long any single step of getting the model ready may take before we stop
 *  waiting for it. Chosen under Android's ~5 s input-dispatch ANR window: if a
 *  native call is going to hang, we want our own account of it first, and a
 *  hands-free session that starts listening rather than one stuck mid-tap. A
 *  2 MB asset copy is ~50 ms and a session creation well under a second, so
 *  nothing healthy comes near this. */
const STEP_DEADLINE_MS = 4_000;
const DEADLINE = 'VadDeadline';

function withDeadline<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`no answer in ${STEP_DEADLINE_MS} ms`);
      err.name = DEADLINE;
      reject(err);
    }, STEP_DEADLINE_MS);
    work.then(
      v => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/** The real model is ≈2 MB. Anything dramatically smaller is not a model — it
 *  is the wreckage of a copy that was interrupted partway. */
const MIN_MODEL_BYTES = 500_000;

async function resolveModelPath(assetName: string): Promise<string> {
  // On Android, bundle assets cannot be opened directly by ONNX Runtime — we
  // copy them to the document directory on first launch.
  // On iOS, the model is in the main bundle and can be referenced directly.
  const RNFS = fs();

  if (Platform.OS === 'ios') {
    return `${RNFS.MainBundlePath}/${assetName}`;
  }

  // Every line below announces the native call it is about to make, not the
  // one it just finished. A process killed inside one of these leaves no
  // exception and no completion line, so the last entry in the log IS the
  // finding — "checking the copy on disk" as a final word means `exists` or
  // `stat` never came back, and "copying the model out of the APK" means the
  // asset copy did not. Chatty for one-time work, and the only instrument that
  // survives the failure it is describing.
  const destPath = `${RNFS.DocumentDirectoryPath}/${assetName}`;
  log.info('[vad] checking the copy on disk');
  if (await modelLooksUsable(RNFS, destPath)) {
    log.info('[vad] model already on disk');
    return destPath;
  }

  // copyFileAssets writes straight to its destination, so a copy interrupted
  // by a kill or a full disk leaves a truncated file that every later launch
  // accepts on sight — handing ONNX Runtime a malformed model forever. Land it
  // on a scratch path and rename, which is atomic on the same filesystem.
  const tmpPath = `${destPath}.part`;
  try { await RNFS.unlink?.(tmpPath); } catch { /* nothing to clean up */ }
  if (RNFS.moveFile) {
    log.info('[vad] copying the model out of the APK');
    await RNFS.copyFileAssets(assetName, tmpPath);
    try { await RNFS.unlink?.(destPath); } catch { /* first run */ }
    log.info('[vad] renaming the copy into place');
    await RNFS.moveFile(tmpPath, destPath);
  } else {
    log.info('[vad] copying the model out of the APK');
    await RNFS.copyFileAssets(assetName, destPath);
  }
  log.info(`[vad] model copied to ${destPath}`);
  return destPath;
}

/** Present, and big enough to be the real thing. A `stat` we can't run leaves
 *  us with existence alone — which is what this check used to be. */
async function modelLooksUsable(RNFS: Fs, path: string): Promise<boolean> {
  if (!(await RNFS.exists(path))) return false;
  if (!RNFS.stat) return true;
  try {
    const size = Number((await RNFS.stat(path)).size);
    if (Number.isFinite(size) && size < MIN_MODEL_BYTES) {
      log.warn(`[vad] model on disk is ${size} bytes — truncated, re-copying`);
      return false;
    }
  } catch {
    return true; // stat unavailable at runtime — trust the existence check
  }
  return true;
}

// ── Crash-loop guard ─────────────────────────────────────────────────────────
//
// Getting the model ready is native work from end to end: copying 2 MB out of
// the APK, renaming it into place, handing the path to a model loader. When
// any of it takes the process down there is no exception to catch and no log
// line to find — the app simply restarts, and since turning hands-free on is
// what triggers it, the next attempt does exactly the same thing.
//
// So the attempt is claimed on disk before the first native call and released
// when the last one returns, failure included. A claim still standing at the
// next launch can only mean the work never returned at all, and this run skips
// the model — hands-free then runs on the energy detector, which needs no
// model. A crash costs the model, not the app.
//
// The scope of the claim is the whole of that work, and learning that cost a
// build: the first version staked it after the asset copy, which is precisely
// where a device was dying, so every launch walked into the same hole with the
// guard sitting uselessly downstream. A guard that does not cover the first
// native call does not cover anything.
//
// Skip once, then try again — the claim is cleared as it is honoured. An
// earlier version made it sticky, on the theory that retrying something which
// had already killed the process once was how a crash loop starts. That was
// written while this guard was chasing the wrong fault: the crash it was built
// for turned out to be a pasted diagnostics log going out as an Authorization
// header, nothing to do with the model at all. Which makes the realistic
// failure here a false positive, and a sticky claim answers a false positive
// by disabling on-device speech detection permanently and silently. Skipping
// one launch is enough to break a loop and cheap enough to be wrong about;
// the per-step deadline above already covers a load that merely hangs.

const LOAD_CLAIM = 'silero_vad.loading';

/** True if this run should attempt to get the model ready. */
async function claimModelLoad(): Promise<boolean> {
  try {
    const RNFS = fs();
    const claim = `${RNFS.DocumentDirectoryPath}/${LOAD_CLAIM}`;
    if (await RNFS.exists(claim)) {
      // Honour it and retire it in the same breath: this run goes without the
      // model, the next one is free to try again.
      await RNFS.unlink?.(claim);
      return false;
    }
    await RNFS.writeFile?.(claim, String(Date.now()), 'utf8');
  } catch {
    // No filesystem, no guard — attempt the load, as every run did before
    // this existed. The guard must never be the reason the model is skipped.
  }
  return true;
}

async function clearModelLoadClaim(): Promise<void> {
  try {
    const RNFS = fs();
    await RNFS.unlink?.(`${RNFS.DocumentDirectoryPath}/${LOAD_CLAIM}`);
  } catch { /* never claimed, or already gone */ }
}
