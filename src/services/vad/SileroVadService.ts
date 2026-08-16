// SileroVadService — on-device Voice Activity Detection via Silero VAD v5.
//
// Runs silero_vad.onnx (≈2 MB) through onnxruntime-react-native: 512-sample
// (32 ms) frames at 16 kHz in, a speech probability out, with an RNN state
// carried across frames. This service owns that state and the silence hangover
// that keeps a breath from fragmenting an utterance.
//
// Read the energy path as the primary one, not the fallback its naming
// suggests: on the hardware this ships against the model returns 0.001–0.002
// for speech loud enough to clip, so every turn in every device log so far was
// decided by RMS alone.
//
// Endpointing is two-stage. `onSpeechPause` fires early (pauseHintMs) and
// `onSpeechEnd` late (silenceHangoverMs), because silence alone is weak
// evidence that someone finished — strong only after a long wait, which makes
// the hangover the largest fixed latency in hands-free. The hint lets a
// subscriber holding better evidence (a transcript that just closed a
// sentence) end the turn early while anything ambiguous waits it out.
//
// The model lives at android/app/src/main/assets/ and in the iOS bundle; on
// Android initialize() copies it to DocumentDirectoryPath, since ONNX Runtime
// cannot open an APK asset directly.

import { log } from '../log/logStore';
import { Platform } from 'react-native';
import { toError } from '../../app/errors';

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
  /** Silence before the early, non-committal `onSpeechPause` hint (ms). Must be
   *  shorter than the hangover; ignored otherwise. */
  readonly pauseHintMs?: number;
  /**
   * RMS at which a SILENT room is considered to have started speaking (0-1). A
   * frame is speech if either the model probability or the RMS clears its bar.
   * Default 0.05, deliberately high — a room with a television in it clears
   * anything lower. Set to 0 to rely on model probability alone.
   */
  readonly energySpeechThreshold?: number;
  /**
   * RMS at which an ALREADY-SPEAKING room is considered to still be speaking.
   * Lower than energySpeechThreshold, and the gap between them is the point.
   *
   * One threshold cannot do both jobs. Speech is not a plateau — vowels run ten
   * to twenty dB above consonants — so a bar set high enough to ignore a quiet
   * room sits *inside* the dynamic range of the sentence it is tracking. The
   * detector then sees a handful of loud syllables separated by "silence" and
   * the hangover expires mid-sentence: measured on device, 96 / 180 / 410 ms of
   * "speech" for three whole sentences, two of which reached the transcriber as
   * nothing at all.
   *
   * So entering costs more evidence than staying. Standard squelch design, and
   * it separates the failures: the entry bar fights false starts, the sustain
   * bar fights chopped sentences, neither drags the other.
   *
   * Defaults to 40% of energySpeechThreshold (≈8 dB below it).
   */
  readonly energySustainThreshold?: number;
  /** Hard ceiling on one utterance (ms), default 15 s. The sustain bar is by
   *  design close to the noise in a bad room, so a detector that can hold a
   *  turn open needs something that cannot fail to close one. Reaching it is a
   *  bug report; the alternative is an app that silently never answers. */
  readonly maxUtteranceMs?: number;
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
  Tensor: new (type: string, data: OrtTensor['data'], dims: number[]) => OrtTensor;
};
let ortModule: OrtModule | null = null;
function getOrt(): OrtModule {
  if (!ortModule) {
    // SAFETY: OrtModule names the one constructor this file uses, matching the
    // package's published signature. Required lazily (so Jest can mock first),
    // and require() is untyped — hence the assertion.
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
  private speakingSince = 0;
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
  private readonly energySustainThreshold: number;
  private readonly maxUtteranceMs: number;
  private readonly sessionFactory: OrtSessionFactory;

  constructor(config: VadConfig = {}, sessionFactory?: OrtSessionFactory) {
    this.threshold = config.speechProbThreshold ?? 0.08;
    this.hangoverMs = config.silenceHangoverMs ?? 800;
    this.pauseHintMs = config.pauseHintMs ?? 0;
    this.energyThreshold = config.energySpeechThreshold ?? 0.05;
    // Derived, not a second literal: a caller that moves the entry bar for its
    // own room should carry the sustain bar with it. Clamped below the entry
    // bar because a sustain threshold at or above it is not hysteresis, and
    // silently behaving like one threshold is how this was broken before.
    this.energySustainThreshold = Math.min(
      config.energySustainThreshold ?? this.energyThreshold * 0.4,
      this.energyThreshold,
    );
    this.maxUtteranceMs = config.maxUtteranceMs ?? 15000;
    this.sessionFactory = sessionFactory ?? defaultOrtSessionFactory;
  }

  /**
   * Get the model ready, or decide to live without it. Never throws: the
   * caller is a speaker turning hands-free on, and the answer to "the model is
   * unavailable" is a VAD listening on energy, not a dead feature.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Claimed before the FIRST native call — see the crash-loop guard below.
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
      const err = toError(e);
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

  /** Reset the RNN state and speaking flag, keeping the ONNX session. Called
   *  between HF sessions so stale state can't suppress the next one. */
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
    this.resetState();
    this.subscribers = [];
    this.session = null;
    this.initialized = false;
    this.inferenceRunning = false;
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
        const feeds = {
          input: new ort.Tensor('float32', input, [1, VAD_FRAME_SAMPLES]),
          state: new ort.Tensor('float32', new Float32Array(this.state), STATE_DIMS),
          sr: new ort.Tensor('int64', SR_DATA, [1]),
        } satisfies Record<string, OrtTensor>;

        const results = await this.session.run(feeds);

        // SAFETY: `output` is float32 in the Silero VAD model this loads.
        prob = (results['output'].data as Float32Array)[0];
        // SAFETY: `stateN` is the recurrent state, likewise float32. Copied
        // into a JS-owned buffer so later session.run() calls cannot corrupt
        // the reference through native buffer reuse.
        const stateNRaw = results['stateN'].data as Float32Array;
        this.state = new Float32Array(stateNRaw);
      }

      this.processProbability(prob, frameRms);
    } catch (e) {
      log.error('[vad] frame inference error', toError(e));
    }
  }

  private processProbability(prob: number, frameRms: number): void {
    this.frameCount++;
    if (prob > this.maxProbWindow) this.maxProbWindow = prob;
    if (this.frameCount % 50 === 0) {
      log.info(`[vad] frames=${this.frameCount} maxProb=${this.maxProbWindow.toFixed(3)} maxAmp=${this.maxAmpWindow.toFixed(3)} maxRms=${this.maxRmsWindow.toFixed(4)} threshold=${this.threshold} energyThr=${this.energyThreshold} sustainThr=${this.energySustainThreshold.toFixed(3)} speaking=${this.speaking}`);
      this.maxProbWindow = 0;
      this.maxAmpWindow = 0;
      this.maxRmsWindow = 0;
    }

    const isModelSpeech = prob >= this.threshold;
    // Which bar this frame has to clear depends on whether anyone is already
    // talking: starting a turn is a claim about a silent room, continuing one
    // is a claim about a sentence already in progress. See energySustainThreshold.
    const energyBar = this.speaking ? this.energySustainThreshold : this.energyThreshold;
    const isEnergySpeech = this.energyThreshold > 0 && frameRms >= energyBar;
    const isSpeech = isModelSpeech || isEnergySpeech;

    if (isSpeech) {
      const now = Date.now();
      // The one thing that can end a turn the sustain bar is holding open. A
      // room noisy enough to sit above that bar would otherwise keep an
      // utterance alive with nobody speaking, and no later frame could ever
      // close it — the detector would simply stop answering.
      if (this.speaking && now - this.speakingSince >= this.maxUtteranceMs) {
        log.warn(
          `[vad] utterance hit the ${this.maxUtteranceMs} ms ceiling — ending it. ` +
          `The room is probably sitting above the sustain threshold ` +
          `(${this.energySustainThreshold.toFixed(3)}).`,
        );
        this.clearSilenceTimers();
        this.pauseHintEmitted = false;
        this.speaking = false;
        this.lastSpeechAt = now;
        this.emit('end', now);
        return;
      }
      this.lastSpeechAt = now;
      this.clearSilenceTimers();
      if (this.pauseHintEmitted) {
        this.pauseHintEmitted = false;
        this.emit('resume', this.lastSpeechAt);
      }
      if (!this.speaking) {
        this.speaking = true;
        this.speakingSince = this.lastSpeechAt;
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
        log.error('[vad] subscriber error', toError(e));
      }
    }
  }
}

// ── Default ONNX session factory ─────────────────────────────────────────────

/** The one entry point of onnxruntime-react-native that loads a model. */
interface OrtInferenceSessionFactory {
  readonly InferenceSession: { create: (path: string) => Promise<OrtSession> };
}

async function defaultOrtSessionFactory(modelPath: string): Promise<OrtSession> {
  // SAFETY: matches the package's published `InferenceSession.create`; lazy
  // for the same reason as getOrt().
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ort = require('onnxruntime-react-native') as OrtInferenceSessionFactory;
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
  // SAFETY: `Fs` above lists only the members this file calls, each matching
  // the package's own declarations, with the platform-specific ones optional.
  // Lazy so Jest can map the module to its fake first.
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
      (cause: unknown) => { clearTimeout(timer); reject(toError(cause)); },
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

  // Every line below announces the native call it is ABOUT to make. A process
  // killed inside one leaves no exception and no completion line, so the last
  // entry in the log is the finding. Chatty for one-time work, and the only
  // instrument that survives the failure it describes.
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
  log.info('[vad] copying the model out of the APK');
  if (RNFS.moveFile) {
    await RNFS.copyFileAssets(assetName, tmpPath);
    try { await RNFS.unlink?.(destPath); } catch { /* first run */ }
    log.info('[vad] renaming the copy into place');
    await RNFS.moveFile(tmpPath, destPath);
  } else {
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
// Getting the model ready is native work end to end — copying 2 MB out of the
// APK, renaming it into place, handing the path to a loader — and when any of
// it takes the process down there is no exception to catch and no line to find.
// The app just restarts, and since turning hands-free on is what triggers it,
// the next attempt does exactly the same thing.
//
// So the attempt is claimed on disk before the FIRST native call (a guard that
// starts after the asset copy misses the step a device was actually dying in)
// and released when the last one returns, failure included. A claim still
// standing at the next launch means the work never returned, so that run skips
// the model and hands-free listens on energy alone: a crash costs the model,
// not the app.
//
// Skip once, then try again — the claim is retired as it is honoured. Sticky
// would answer a false positive by disabling speech detection permanently and
// silently, and the per-step deadline above already covers a load that hangs.

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
