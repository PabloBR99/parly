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
// ── What makes a frame speech ────────────────────────────────────────────────
//
// Two questions, asked separately and ANDed, because they are genuinely
// different questions and one detector cannot answer both:
//
//   1. Is this loud enough to be the person at this table?  — the near-field
//      gate, a distance in dB above the tracked noise floor (see noiseFloor).
//   2. Does it sound like speech at all?                     — the model.
//
// The model cannot answer (1) and it is important to see why, because it is
// the whole reason a room with a television in it defeats a VAD that is doing
// its job perfectly. Silero reports p≈0.95 on a news anchor across the room,
// and it is *right*: that is speech. It is simply not speech anyone is trying
// to translate. No probability threshold separates the two, because the
// difference between them is not in the signal's speechness — it is in how far
// away it was spoken. Only level relative to the room carries that.
//
// The gate cannot answer (2) either: a plate set down next to the phone clears
// any distance test there is. So both, and both every frame.
//
// The AND replaced an OR — the model's probability OR a fixed RMS threshold —
// and the OR was the bug. A disjunction can only ever add detections, so its
// energy arm was a permanent one-way ratchet towards more speech; the fixed
// level it compared against (0.05 RMS ≈ -26 dBFS) sits inside the range of
// ordinary conversational speech, which means that in any room noisier than a
// living room it was simply always true. The detector latched on and the
// hangover never expired.
//
// The model keeps a veto rather than a vote, so its threshold is set low: with
// the gate carrying near/far, the model's job here is to refuse cutlery and
// door slams, not to be the primary detector Silero's own default of 0.5
// assumes it is. And the veto is withdrawn entirely on hardware where the
// model returns near-zero for real speech — see modelMute below. A detector
// that goes deaf is worse than one that is occasionally credulous.
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
import { FRAME_MS } from '../audio/audioLevelBus';
import { NoiseFloorTracker, rmsToDbfs } from '../audio/noiseFloor';

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
   * How far above the tracked noise floor a frame must sit to be treated as
   * the person at this table rather than the room behind them (dB). See
   * DEFAULT_MARGIN_DB in noiseFloor for how the number was chosen. Set to a
   * large negative value to effectively disable the gate.
   */
  readonly snrMarginDb?: number;
  /**
   * How long a run of speech-positive frames must last before it counts as
   * someone starting to talk (ms).
   *
   * A single 32 ms frame was never enough evidence to open a turn on, and in a
   * room with plates and chairs in it that showed. Impulsive noise is short by
   * nature — cutlery, a door, a knock on the table are all under ~100 ms — so
   * requiring a run is what separates them from the shortest real word, which
   * is several times longer. The cost is that speech_start arrives this much
   * later, which nothing downstream can see: audio reaches the transcriber
   * continuously and independently of this, so the delay costs state latency,
   * never words.
   */
  readonly minSpeechMs?: number;
  /**
   * How much room tone `calibrate()` samples before the detector starts
   * answering (ms). See calibrate().
   */
  readonly calibrationMs?: number;
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

/**
 * How much clearly-near-field audio the model may stay silent through before
 * its veto is withdrawn. ≈3 s — long enough that it cannot be tripped by one
 * quiet sentence, short enough that a device whose model is mute loses at most
 * the opening exchange of a conversation rather than the whole of it.
 */
const MODEL_MUTE_FRAMES = 96;

/** Grace on top of the calibration window before it gives up waiting for
 *  frames. Capture can take a moment to deliver its first chunk, and a
 *  calibration that never finishes is a detector that never listens. */
const CALIBRATION_GRACE_MS = 1_000;

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

  /** How loud the room is when nobody at this table is talking. */
  private readonly noise: NoiseFloorTracker;
  /** Consecutive speech-positive frames. A run shorter than minSpeechFrames is
   *  not speech yet — see minSpeechMs. */
  private speechRun = 0;
  /** Near-field frames the model has had the chance to call speech and has
   *  not. Reset by any frame it does call speech. */
  private modelSilentFrames = 0;
  /** The model has been observed to return near-zero through audio it should
   *  have had an opinion about; its veto is withdrawn for this session. */
  private modelMute = false;
  /** Room tone being collected right now. Non-null means every frame is a
   *  measurement and no frame is an event. */
  private calibration: {
    levels: number[];
    frames: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private readonly threshold: number;
  private readonly hangoverMs: number;
  private readonly pauseHintMs: number;
  private readonly minSpeechFrames: number;
  private readonly calibrationMs: number;
  private readonly sessionFactory: OrtSessionFactory;

  constructor(config: VadConfig = {}, sessionFactory?: OrtSessionFactory) {
    // Low on purpose, and lower than Silero's own default of 0.5. The model is
    // a veto here, not the detector — the near-field gate decides who is
    // talking, and this only has to refuse the things that are not talking at
    // all. See the header.
    this.threshold = config.speechProbThreshold ?? 0.3;
    this.hangoverMs = config.silenceHangoverMs ?? 800;
    this.pauseHintMs = config.pauseHintMs ?? 0;
    this.minSpeechFrames = Math.max(1, Math.round((config.minSpeechMs ?? 96) / FRAME_MS));
    this.calibrationMs = config.calibrationMs ?? 400;
    this.noise = new NoiseFloorTracker({ marginDb: config.snrMarginDb });
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
    // No session is not the same as no VAD: the near-field gate needs no model,
    // and on hardware where the model returns near-zero for real speech it is
    // already the thing taking every turn.
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
      this.speechRun = 0;
    }
  }

  /**
   * Listen to the room for a moment before answering questions about it.
   *
   * Every threshold in here is a distance above the room's own level, and the
   * tracker that measures that level needs a few seconds of audio to converge
   * from its starting guess. Those seconds are the beginning of the
   * conversation. Seeding it with a short sample first means the first thing
   * anyone says is judged against the room they said it in, instead of being
   * the utterance that pays for the measurement.
   *
   * Deliberately not a moment anyone can see. There is no "hold still while we
   * calibrate" — it runs in the ~400 ms between tapping hands-free on and the
   * first word, it is over before a hand leaves the screen, and speech events
   * are simply suppressed while it runs. A calibration the user has to perform
   * is a calibration that tells them the app is fragile.
   *
   * Being invisible, it can also be walked over: someone may already be
   * talking. Three things make that survivable — the sample is a lower
   * quartile rather than a mean, the installed floor is capped, and the
   * tracker falls fast, so a floor seeded on a voice is back on the room within
   * about a second of quiet. Worth knowing about, not worth a dialog.
   *
   * Requires the detector to be active; frames do not reach it otherwise.
   */
  calibrate(): void {
    this.cancelCalibration();
    this.calibration = {
      levels: [],
      frames: Math.max(1, Math.round(this.calibrationMs / FRAME_MS)),
      // Frames normally finish this well before the timer does. The timer is
      // for the case where they never arrive at all.
      timer: setTimeout(
        () => this.finishCalibration('timeout'),
        this.calibrationMs + CALIBRATION_GRACE_MS,
      ),
    };
  }

  /**
   * What the detector currently believes about the room and about itself.
   *
   * Read-only, and the read model for two things: the log line below, and
   * anything that wants to tell the speakers their room is too loud for
   * hands-free to work — which, when the gate is pinned at its ceiling and
   * nothing is getting through, is a more useful thing to say than nothing.
   */
  diagnostics(): { floorDb: number; gateDb: number; seeded: boolean; modelMute: boolean } {
    return {
      floorDb: this.noise.floor,
      gateDb: this.noise.gate,
      seeded: this.noise.seeded,
      modelMute: this.modelMute,
    };
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
    // The next speaker starts from no evidence, not from whatever the last one
    // left on the counter.
    this.speechRun = 0;
  }

  /** Reset the RNN state and speaking flag without destroying the ONNX session.
   *  Call between HF sessions to prevent stale state from a previous run
   *  affecting speech detection in the new session. */
  resetState(): void {
    this.clearSilenceTimers();
    this.cancelCalibration();
    this.pauseHintEmitted = false;
    this.state = new Float32Array(STATE_SIZE);
    this.speaking = false;
    this.speechRun = 0;
    this.frameCount = 0;
    this.maxProbWindow = 0;
    this.maxAmpWindow = 0;
    this.maxRmsWindow = 0;
    this.inferenceQueue = [];
    // A room heard in the last session is not evidence about this one — the
    // phone may be in a different building. The next calibrate() reseeds.
    this.noise.reset();
    // The model gets its veto back for every session. Withdrawing it is a
    // judgement made from a few seconds of audio, and a judgement that cheap
    // should not be able to disable the model for the life of the process: the
    // cost of re-testing is three seconds of gate-only detection, and the cost
    // of a sticky false positive is a device that never uses its model again.
    this.modelMute = false;
    this.modelSilentFrames = 0;
  }

  destroy(): void {
    this.clearSilenceTimers();
    this.cancelCalibration();
    this.pauseHintEmitted = false;
    this.subscribers = [];
    this.session = null;
    this.initialized = false;
    this.speaking = false;
    this.speechRun = 0;
    this.inferenceQueue = [];
    this.inferenceRunning = false;
    this.state = new Float32Array(STATE_SIZE);
    this.frameCount = 0;
    this.maxProbWindow = 0;
    this.maxAmpWindow = 0;
    this.maxRmsWindow = 0;
    this.noise.reset();
    this.modelMute = false;
    this.modelSilentFrames = 0;
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

      // Without a model there is no probability to have — 0, and the veto is
      // withdrawn below so the near-field gate decides on its own.
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

      this.processFrame(prob, frameRms);
    } catch (e) {
      log.error('[vad] frame inference error', e instanceof Error ? e : new Error(String(e)));
    }
  }

  private processFrame(prob: number, frameRms: number): void {
    const levelDb = rmsToDbfs(frameRms);

    // While calibrating, every frame is a measurement of the room and none of
    // them is an event. Returning here is what makes the window invisible.
    if (this.calibration !== null) {
      this.calibration.levels.push(levelDb);
      if (this.calibration.levels.length >= this.calibration.frames) {
        this.finishCalibration('sampled');
      }
      return;
    }

    const nearField = this.noise.passes(levelDb);
    // The floor learns from everything except the person in front of it. Let a
    // near-field frame push it up and a long utterance walks the floor along
    // under its own voice until the speaker gates themselves out mid-sentence.
    this.noise.observe(levelDb, nearField || this.speaking);

    this.frameCount++;
    if (prob > this.maxProbWindow) this.maxProbWindow = prob;
    if (this.frameCount % 50 === 0) {
      log.info(`[vad] frames=${this.frameCount} maxProb=${this.maxProbWindow.toFixed(3)} maxAmp=${this.maxAmpWindow.toFixed(3)} maxRms=${this.maxRmsWindow.toFixed(4)} floor=${this.noise.floor.toFixed(1)}dB gate=${this.noise.gate.toFixed(1)}dB level=${levelDb.toFixed(1)}dB threshold=${this.threshold} modelMute=${this.modelMute} speaking=${this.speaking}`);
      this.maxProbWindow = 0;
      this.maxAmpWindow = 0;
      this.maxRmsWindow = 0;
    }

    // A model that never fires on audio this close and this loud is not
    // vetoing noise, it is broken — and a broken veto ANDed with the gate is a
    // detector that hears nothing at all. Withdraw it and let the gate work
    // alone, which is what this device was effectively doing anyway.
    if (this.session !== null && !this.modelMute && nearField) {
      if (prob >= this.threshold) {
        this.modelSilentFrames = 0;
      } else if (++this.modelSilentFrames >= MODEL_MUTE_FRAMES) {
        this.modelMute = true;
        log.warn(
          `[vad] the model stayed silent through ${MODEL_MUTE_FRAMES} near-field frames — ` +
          'dropping its veto and listening on the noise floor alone',
        );
      }
    }

    // Both questions, ANDed. The model's half is skipped only when there is no
    // model to ask, or when asking it has been shown to be pointless.
    const modelSpeech = prob >= this.threshold;
    const modelUsable = this.session !== null && !this.modelMute;
    const candidate = nearField && (modelSpeech || !modelUsable);

    // One run, one meaning of "speech", used everywhere below. A frame only
    // counts once it is part of a run long enough to not be a plate — which
    // makes it exactly as true for cancelling a hangover mid-sentence as it is
    // for opening a turn. That matters more than it sounds: a lone frame of
    // clatter clearing the gate during the hangover would otherwise keep
    // extending an utterance that ended, one plate at a time, forever.
    this.speechRun = candidate ? this.speechRun + 1 : 0;
    const isSpeech = this.speechRun >= this.minSpeechFrames;

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

  /** Install whatever room tone was collected and start answering again.
   *  Idempotent — the frame count and the timer both race to call it. */
  private finishCalibration(reason: 'sampled' | 'timeout'): void {
    const c = this.calibration;
    if (c === null) return;
    clearTimeout(c.timer);
    this.calibration = null;

    if (c.levels.length === 0) {
      // No audio arrived in the window. Say so plainly and carry on with the
      // starting guess, which is permissive: a calibration that could not run
      // must never be the reason hands-free hears nothing.
      log.warn('[vad] calibration heard no audio — keeping the default noise floor');
      return;
    }
    const floor = this.noise.seed(c.levels);
    log.info(
      `[vad] room measured (${reason}, ${c.levels.length} frames): ` +
      `floor=${floor.toFixed(1)}dBFS gate=${this.noise.gate.toFixed(1)}dBFS`,
    );
  }

  private cancelCalibration(): void {
    if (this.calibration === null) return;
    clearTimeout(this.calibration.timer);
    this.calibration = null;
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
