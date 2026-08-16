/**
 * SileroVadService tests — ONNX runtime and RNFS fully mocked.
 */

// The asset-copy path this suite exercises is Android's: on iOS the model
// ships inside the bundle and there is nothing to copy. Jest runs the real
// react-native, which reports iOS, so the platform is stubbed here.
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
}));

// ONNX Runtime and RNFS have no JS implementation to run under Jest, and the
// service reaches them through require() — so they are mocked, not injected.
jest.mock('onnxruntime-react-native', () => ({
  InferenceSession: {
    create: jest.fn(),
  },
  Tensor: jest.fn().mockImplementation((type, data, dims) => ({ type, data, dims })),
}), { virtual: true });

// A real enough filesystem to exercise the model copy and the crash-loop
// claim: both care about which specific paths exist and how big they are, and
// an `exists` that says yes to everything would have the service permanently
// convinced a load was already in flight.
const mockFsFiles = new Map<string, number>();

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  MainBundlePath: '/bundle',
  exists: jest.fn(async (p: string) => mockFsFiles.has(p)),
  stat: jest.fn(async (p: string) => {
    const size = mockFsFiles.get(p);
    if (size === undefined) throw new Error(`ENOENT: ${p}`);
    return { size };
  }),
  copyFileAssets: jest.fn(async (_src: string, dest: string) => {
    mockFsFiles.set(dest, mockModelBytes);
  }),
  copyFile: jest.fn().mockResolvedValue(undefined),
  moveFile: jest.fn(async (src: string, dest: string) => {
    mockFsFiles.set(dest, mockFsFiles.get(src) ?? 0);
    mockFsFiles.delete(src);
  }),
  unlink: jest.fn(async (p: string) => { mockFsFiles.delete(p); }),
  writeFile: jest.fn(async (p: string, contents: string) => {
    mockFsFiles.set(p, contents.length);
  }),
}), { virtual: true });

const MODEL_PATH = '/docs/silero_vad.onnx';
const CLAIM_PATH = '/docs/silero_vad.loading';
const mockModelBytes = 2_000_000;

beforeEach(() => {
  mockFsFiles.clear();
  mockFsFiles.set(MODEL_PATH, mockModelBytes);
});

import { SileroVadService, VAD_FRAME_SAMPLES, type OrtSession, type OrtTensor } from '../SileroVadService';

// ── Mock ONNX session ─────────────────────────────────────────────────────────

function makeOrtSession(speechProbSequence: number[]): OrtSession {
  let callIndex = 0;
  return {
    run: jest.fn(async (): Promise<Record<string, OrtTensor>> => {
      const prob = speechProbSequence[callIndex] ?? 0;
      callIndex++;
      return {
        output: { data: new Float32Array([prob]) },
        stateN: { data: new Float32Array(256) },
      };
    }),
  };
}

function makeSessionFactory(session: OrtSession) {
  return jest.fn().mockResolvedValue(session);
}

function silence(): Int16Array {
  return new Int16Array(VAD_FRAME_SAMPLES);
}

function voice(): Int16Array {
  const frame = new Int16Array(VAD_FRAME_SAMPLES);
  for (let i = 0; i < VAD_FRAME_SAMPLES; i++) {
    frame[i] = Math.floor(Math.sin(i * 0.1) * 8000);
  }
  return frame;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SileroVadService', () => {
  it('calls sessionFactory with the model path on initialize()', async () => {
    const session = makeOrtSession([]);
    const factory = makeSessionFactory(session);
    const svc = new SileroVadService({}, factory);

    await svc.initialize();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0]).toContain('silero_vad.onnx');
  });

  it('initialize() is idempotent — second call is a no-op', async () => {
    const session = makeOrtSession([]);
    const factory = makeSessionFactory(session);
    const svc = new SileroVadService({}, factory);

    await svc.initialize();
    await svc.initialize();

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('fires onSpeechStart when prob crosses threshold', async () => {
    const session = makeOrtSession([0.1, 0.1, 0.9]); // below, below, above
    const factory = makeSessionFactory(session);
    const svc = new SileroVadService({ speechProbThreshold: 0.5 }, factory);
    await svc.initialize();

    const starts: number[] = [];
    svc.subscribe(() => starts.push(Date.now()), () => {});

    await new Promise<void>(r => {
      svc.feedFrame(silence()); // 0.1
      svc.feedFrame(silence()); // 0.1
      svc.feedFrame(voice());   // 0.9 — should trigger start
      setTimeout(r, 50);
    });

    expect(starts).toHaveLength(1);
  });

  it('fires onSpeechEnd after silence hangover', async () => {
    jest.useFakeTimers();
    try {
      const probSeq = [0.9, 0.9, 0.1];
      const session = makeOrtSession(probSeq);
      const factory = makeSessionFactory(session);
      const svc = new SileroVadService(
        { speechProbThreshold: 0.5, silenceHangoverMs: 800 },
        factory,
      );
      await svc.initialize();

      const ends: number[] = [];
      svc.subscribe(() => {}, () => ends.push(Date.now()));

      // Feed two speech frames then one silence frame — starts hangover timer.
      svc.feedFrame(voice()); // 0.9
      svc.feedFrame(voice()); // 0.9
      svc.feedFrame(silence()); // 0.1 — sets setTimeout(800)

      // Drain the inference queue (3 frames × ~2 microtask ticks each).
      for (let i = 0; i < 8; i++) await Promise.resolve();

      expect(ends).toHaveLength(0); // timer not fired yet

      jest.advanceTimersByTime(900); // fires the hangover callback

      expect(ends).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('setActive(false) suppresses speech events', async () => {
    const session = makeOrtSession([0.9, 0.9]);
    const factory = makeSessionFactory(session);
    const svc = new SileroVadService({}, factory);
    await svc.initialize();

    const starts: number[] = [];
    svc.subscribe(() => starts.push(Date.now()), () => {});

    svc.setActive(false);
    svc.feedFrame(voice());
    svc.feedFrame(voice());

    await new Promise<void>(r => setTimeout(r, 50));

    expect(starts).toHaveLength(0);
  });

  it('setActive(true) re-enables events after gating', async () => {
    const session = makeOrtSession([0.9, 0.9, 0.9]);
    const factory = makeSessionFactory(session);
    const svc = new SileroVadService({}, factory);
    await svc.initialize();

    const starts: number[] = [];
    svc.subscribe(() => starts.push(Date.now()), () => {});

    svc.setActive(false);
    svc.feedFrame(voice()); // suppressed
    await new Promise<void>(r => setTimeout(r, 10));
    expect(starts).toHaveLength(0);

    svc.setActive(true);
    svc.feedFrame(voice()); // should trigger
    await new Promise<void>(r => setTimeout(r, 50));
    expect(starts).toHaveLength(1);
  });

  it('subscribe returns unsubscribe that stops callbacks', async () => {
    const session = makeOrtSession([0.9]);
    const factory = makeSessionFactory(session);
    const svc = new SileroVadService({}, factory);
    await svc.initialize();

    const starts: number[] = [];
    const unsub = svc.subscribe(() => starts.push(1), () => {});
    unsub();

    svc.feedFrame(voice());
    await new Promise<void>(r => setTimeout(r, 50));

    expect(starts).toHaveLength(0);
  });

  it('drops frames that are not exactly VAD_FRAME_SAMPLES long', async () => {
    const session = makeOrtSession([0.9]);
    const factory = makeSessionFactory(session);
    const svc = new SileroVadService({}, factory);
    await svc.initialize();

    const starts: number[] = [];
    svc.subscribe(() => starts.push(1), () => {});

    // Wrong size — should be silently dropped
    svc.feedFrame(new Int16Array(100));
    await new Promise<void>(r => setTimeout(r, 50));

    expect(session.run).not.toHaveBeenCalled();
    expect(starts).toHaveLength(0);
  });

  it('destroy() clears all state and subscribers', async () => {
    const session = makeOrtSession([0.9]);
    const factory = makeSessionFactory(session);
    const svc = new SileroVadService({}, factory);
    await svc.initialize();

    const starts: number[] = [];
    svc.subscribe(() => starts.push(1), () => {});

    svc.destroy();
    svc.feedFrame(voice()); // should be a no-op after destroy
    await new Promise<void>(r => setTimeout(r, 50));

    expect(starts).toHaveLength(0);
  });

  it('does not fire duplicate onSpeechStart while already speaking', async () => {
    const session = makeOrtSession([0.9, 0.9, 0.9]);
    const factory = makeSessionFactory(session);
    const svc = new SileroVadService({}, factory);
    await svc.initialize();

    const starts: number[] = [];
    svc.subscribe(() => starts.push(1), () => {});

    svc.feedFrame(voice());
    svc.feedFrame(voice());
    svc.feedFrame(voice());
    await new Promise<void>(r => setTimeout(r, 100));

    expect(starts).toHaveLength(1);
  });
});

// ── Two-stage endpointing ────────────────────────────────────────────────────

describe('SileroVadService — pause hint', () => {
  /** Feed frames and drain the inference queue between each. */
  async function feed(svc: SileroVadService, frames: Int16Array[]): Promise<void> {
    for (const f of frames) svc.feedFrame(f);
    for (let i = 0; i < 8 * frames.length; i++) await Promise.resolve();
  }

  it('offers the pause hint well before the hangover concedes the turn', async () => {
    jest.useFakeTimers();
    try {
      const svc = new SileroVadService(
        { speechProbThreshold: 0.5, pauseHintMs: 400, silenceHangoverMs: 600 },
        makeSessionFactory(makeOrtSession([0.9, 0.1])),
      );
      await svc.initialize();

      const pauses: number[] = [];
      const ends: number[] = [];
      svc.subscribe(() => {}, at => ends.push(at), at => pauses.push(at));

      await feed(svc, [voice(), silence()]);
      expect(pauses).toHaveLength(0);

      jest.advanceTimersByTime(450);
      expect(pauses).toHaveLength(1);
      expect(ends).toHaveLength(0); // the turn is still the speaker's

      jest.advanceTimersByTime(200);
      expect(ends).toHaveLength(1);
      // Both report the same instant — when the room actually went quiet.
      expect(ends[0]).toBe(pauses[0]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels the hint when speech resumes — a breath is not an ending', async () => {
    jest.useFakeTimers();
    try {
      const svc = new SileroVadService(
        { speechProbThreshold: 0.5, pauseHintMs: 400, silenceHangoverMs: 600 },
        makeSessionFactory(makeOrtSession([0.9, 0.1, 0.9])),
      );
      await svc.initialize();

      const pauses: number[] = [];
      const ends: number[] = [];
      svc.subscribe(() => {}, at => ends.push(at), at => pauses.push(at));

      await feed(svc, [voice(), silence()]);
      jest.advanceTimersByTime(300); // mid-pause…
      await feed(svc, [voice()]);    // …and they keep talking
      jest.advanceTimersByTime(1_000);

      expect(pauses).toHaveLength(0);
      expect(ends).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('endUtterance() cancels the hangover and re-arms for the next speaker', async () => {
    jest.useFakeTimers();
    try {
      const svc = new SileroVadService(
        { speechProbThreshold: 0.5, pauseHintMs: 400, silenceHangoverMs: 600 },
        makeSessionFactory(makeOrtSession([0.9, 0.1, 0.9])),
      );
      await svc.initialize();

      const starts: number[] = [];
      const ends: number[] = [];
      svc.subscribe(() => starts.push(Date.now()), at => ends.push(at), () => {});

      await feed(svc, [voice(), silence()]);
      expect(starts).toHaveLength(1);

      // A subscriber acted on the hint and took the turn itself.
      svc.endUtterance();
      jest.advanceTimersByTime(1_000);
      // No duplicate ending for a turn already handled.
      expect(ends).toHaveLength(0);

      // And the detector is armed: the next speaker still opens a turn.
      await feed(svc, [voice()]);
      expect(starts).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stays single-stage when no pause hint is configured', async () => {
    jest.useFakeTimers();
    try {
      const svc = new SileroVadService(
        { speechProbThreshold: 0.5, silenceHangoverMs: 600 },
        makeSessionFactory(makeOrtSession([0.9, 0.1])),
      );
      await svc.initialize();

      const pauses: number[] = [];
      const ends: number[] = [];
      svc.subscribe(() => {}, at => ends.push(at), at => pauses.push(at));

      await feed(svc, [voice(), silence()]);
      jest.advanceTimersByTime(1_000);

      expect(pauses).toHaveLength(0);
      expect(ends).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('SileroVadService — resuming after a pause hint', () => {
  async function feed(svc: SileroVadService, frames: Int16Array[]): Promise<void> {
    for (const f of frames) svc.feedFrame(f);
    for (let i = 0; i < 8 * frames.length; i++) await Promise.resolve();
  }

  it('tells subscribers when speech comes back, so work started on the hint can be undone', async () => {
    jest.useFakeTimers();
    try {
      const svc = new SileroVadService(
        { speechProbThreshold: 0.5, pauseHintMs: 400, silenceHangoverMs: 600 },
        makeSessionFactory(makeOrtSession([0.9, 0.1, 0.9])),
      );
      await svc.initialize();

      const events: string[] = [];
      svc.subscribe(
        () => events.push('start'),
        () => events.push('end'),
        () => events.push('pause'),
        () => events.push('resume'),
      );

      await feed(svc, [voice(), silence()]);
      jest.advanceTimersByTime(450);
      expect(events).toEqual(['start', 'pause']);

      await feed(svc, [voice()]);
      expect(events).toEqual(['start', 'pause', 'resume']);

      // And it does not repeat itself while they keep talking.
      await feed(svc, [voice()]);
      expect(events.filter(e => e === 'resume')).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stays silent about resuming when no hint was ever offered', async () => {
    jest.useFakeTimers();
    try {
      const svc = new SileroVadService(
        { speechProbThreshold: 0.5, pauseHintMs: 400, silenceHangoverMs: 600 },
        makeSessionFactory(makeOrtSession([0.9, 0.1, 0.9])),
      );
      await svc.initialize();

      const events: string[] = [];
      svc.subscribe(() => {}, () => events.push('end'), () => events.push('pause'), () => events.push('resume'));

      await feed(svc, [voice(), silence()]);
      jest.advanceTimersByTime(200); // a gap far shorter than the hint
      await feed(svc, [voice()]);
      jest.advanceTimersByTime(1_000);

      expect(events).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── Surviving the model ──────────────────────────────────────────────────────
//
// Reported from a device: turning hands-free on closed the app, relaunch,
// turn it on, closed again. The log ended at "[orch/hf] enabling" every time —
// the stretch that follows is 60 ms of JS on a good day, and it hands off to
// native code that can end the process without raising anything catchable.
// Creating the ONNX session is the one step in it that runs a model loader, so
// it now announces itself on disk before it starts.

describe('SileroVadService — when the model load is what kills the process', () => {
  it('claims the attempt on disk before handing the path to ONNX', async () => {
    let claimedDuringLoad = false;
    const factory = jest.fn().mockImplementation(async () => {
      claimedDuringLoad = mockFsFiles.has(CLAIM_PATH);
      return makeOrtSession([]);
    });

    await new SileroVadService({}, factory).initialize();

    expect(claimedDuringLoad).toBe(true);
  });

  it('claims it before the asset copy too, which is upstream of the load', async () => {
    // The first version of this guard staked the claim after the copy. A
    // device died inside the copy, upstream of it, and every launch walked
    // into the same hole with the guard sitting uselessly downstream.
    mockFsFiles.delete(MODEL_PATH); // nothing copied out of the APK yet

    let claimedDuringCopy = false;
    const RNFS = require('@dr.pogodin/react-native-fs');
    RNFS.copyFileAssets.mockImplementation(async (_src: string, dest: string) => {
      claimedDuringCopy = mockFsFiles.has(CLAIM_PATH);
      mockFsFiles.set(dest, mockModelBytes);
    });

    await new SileroVadService({}, makeSessionFactory(makeOrtSession([]))).initialize();

    expect(claimedDuringCopy).toBe(true);
  });

  it('clears the claim once the model actually loads', async () => {
    await new SileroVadService({}, makeSessionFactory(makeOrtSession([]))).initialize();

    expect(mockFsFiles.has(CLAIM_PATH)).toBe(false);
  });

  it('releases the claim when the load fails cleanly, so the next run retries', async () => {
    const factory = jest.fn().mockRejectedValue(new Error('bad model'));

    // Never throws: the caller is a speaker turning hands-free on, and the
    // answer to "no model" is a VAD on energy, not a dead feature.
    await expect(new SileroVadService({}, factory).initialize()).resolves.toBeUndefined();

    // A throw means the loader came back. That is a failure, not a killing —
    // nothing about it says the next attempt would take the process down.
    expect(mockFsFiles.has(CLAIM_PATH)).toBe(false);
  });

  it('stops waiting on a step that never answers, and keeps the claim', async () => {
    jest.useFakeTimers();
    try {
      const factory = jest.fn().mockImplementation(() => new Promise<never>(() => {}));
      const svc = new SileroVadService({}, factory);

      const settled = svc.initialize();
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(settled).resolves.toBeUndefined();

      // A step that stops answering has the shape of the thing that has been
      // killing the process, so the claim stands and the next launch walks
      // around it rather than into it.
      expect(mockFsFiles.has(CLAIM_PATH)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips the model when a claim from a previous run is still standing', async () => {
    mockFsFiles.set(CLAIM_PATH, 13); // the run that never came back
    const factory = makeSessionFactory(makeOrtSession([0.9]));

    await new SileroVadService({}, factory).initialize();

    expect(factory).not.toHaveBeenCalled();
  });

  it('retires the claim as it honours it, so one bad run is not a life sentence', async () => {
    mockFsFiles.set(CLAIM_PATH, 13);

    await new SileroVadService({}, makeSessionFactory(makeOrtSession([]))).initialize();

    // Skipping a launch is enough to break a loop. Leaving the claim standing
    // would answer a false positive by disabling on-device speech detection
    // permanently and silently, which is the worse way to be wrong.
    expect(mockFsFiles.has(CLAIM_PATH)).toBe(false);
  });

  it('still hears speech with no model at all, on energy alone', async () => {
    mockFsFiles.set(CLAIM_PATH, 13);
    const factory = makeSessionFactory(makeOrtSession([]));
    // A threshold no probability can reach: only the energy path can fire this.
    const svc = new SileroVadService({ speechProbThreshold: 1.1 }, factory);
    await svc.initialize();

    const starts: number[] = [];
    svc.subscribe(() => starts.push(1), () => {});

    svc.feedFrame(voice());
    await new Promise<void>(r => setTimeout(r, 50));

    expect(factory).not.toHaveBeenCalled();
    expect(starts).toHaveLength(1);
  });

  it('re-copies a truncated model rather than handing ONNX the wreckage', async () => {
    // What an interrupted copyFileAssets leaves behind — and what the old
    // existence-only check accepted on every launch from then on.
    mockFsFiles.set(MODEL_PATH, 4_096);
    const factory = makeSessionFactory(makeOrtSession([]));

    await new SileroVadService({}, factory).initialize();

    expect(mockFsFiles.get(MODEL_PATH)).toBe(mockModelBytes);
    expect(factory).toHaveBeenCalledWith(MODEL_PATH);
  });
});

// ── Energy hysteresis ─────────────────────────────────────────────────────────
//
// These tests are all model-mute on purpose: makeOrtSession([]) returns 0 for
// every frame, which is not a contrivance but the only behaviour any device log
// has ever shown. What decides a turn here is RMS, so RMS is what is tested.

/** A frame whose RMS is exactly `rms` (full scale = 1). */
function frameAtRms(rms: number): Int16Array {
  const frame = new Int16Array(VAD_FRAME_SAMPLES);
  const amp = Math.round(rms * 32768);
  for (let i = 0; i < VAD_FRAME_SAMPLES; i++) frame[i] = i % 2 === 0 ? amp : -amp;
  return frame;
}

/** Let the inference queue drain — each frame costs a couple of microtasks. */
async function drain(frames = 1): Promise<void> {
  for (let i = 0; i < frames * 4 + 4; i++) await Promise.resolve();
}

describe('SileroVadService energy hysteresis', () => {
  // Loud enough to open a turn; the peak of an ordinary sentence on device.
  const LOUD = frameAtRms(0.1);
  // Between the two thresholds: the unstressed middle of the same sentence.
  // This is the level that used to read as silence and cut people off.
  const MIDDLE = frameAtRms(0.03);

  it('will not open a turn on speech quieter than the entry threshold', async () => {
    const svc = new SileroVadService({ energySpeechThreshold: 0.05 }, makeSessionFactory(makeOrtSession([])));
    await svc.initialize();
    const starts: number[] = [];
    svc.subscribe(() => starts.push(1), () => {});

    for (let i = 0; i < 5; i++) svc.feedFrame(MIDDLE);
    await drain(5);

    // The entry bar is what keeps a television out of the conversation. It has
    // not moved, and this is the test that says so.
    expect(starts).toHaveLength(0);
  });

  it('keeps a turn open through the quiet middle of a sentence', async () => {
    jest.useFakeTimers();
    try {
      const svc = new SileroVadService(
        { energySpeechThreshold: 0.05, silenceHangoverMs: 600 },
        makeSessionFactory(makeOrtSession([])),
      );
      await svc.initialize();
      const starts: number[] = [];
      const ends: number[] = [];
      svc.subscribe(() => starts.push(1), () => ends.push(1));

      svc.feedFrame(LOUD);
      await drain();
      expect(starts).toHaveLength(1);

      // The speaker keeps talking, just not at the volume of a stressed vowel.
      for (let i = 0; i < 10; i++) svc.feedFrame(MIDDLE);
      await drain(10);

      jest.advanceTimersByTime(1200); // twice the hangover
      expect(ends).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('without hysteresis the same sentence is cut in half', async () => {
    // The bug, written down. Collapsing the sustain bar onto the entry bar is
    // exactly the detector that shipped, and it ends the turn 600 ms into a
    // sentence the speaker is still in the middle of.
    jest.useFakeTimers();
    try {
      const svc = new SileroVadService(
        { energySpeechThreshold: 0.05, energySustainThreshold: 0.05, silenceHangoverMs: 600 },
        makeSessionFactory(makeOrtSession([])),
      );
      await svc.initialize();
      const ends: number[] = [];
      svc.subscribe(() => {}, () => ends.push(1));

      svc.feedFrame(LOUD);
      await drain();
      for (let i = 0; i < 10; i++) svc.feedFrame(MIDDLE);
      await drain(10);

      jest.advanceTimersByTime(1200);
      expect(ends).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never lets the sustain threshold sit at or above the entry threshold', async () => {
    // A config that asks for it silently gets one threshold back, which is the
    // failure this whole mechanism exists to prevent. Clamped instead.
    jest.useFakeTimers();
    try {
      const svc = new SileroVadService(
        { energySpeechThreshold: 0.05, energySustainThreshold: 0.9, silenceHangoverMs: 600 },
        makeSessionFactory(makeOrtSession([])),
      );
      await svc.initialize();
      const ends: number[] = [];
      svc.subscribe(() => {}, () => ends.push(1));

      svc.feedFrame(LOUD);
      await drain();
      // 0.06 clears the clamped sustain bar (0.05) but not the requested 0.9.
      for (let i = 0; i < 5; i++) svc.feedFrame(frameAtRms(0.06));
      await drain(5);

      jest.advanceTimersByTime(1200);
      expect(ends).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ends a turn that the sustain threshold would otherwise hold open forever', async () => {
    // A room noisier than the sustain bar — a television — would keep feeding
    // frames that count as speech, and no later frame could ever close the
    // turn. The ceiling is the only thing that can, so it has to work.
    jest.useFakeTimers();
    try {
      const svc = new SileroVadService(
        // Hangover long enough that it cannot be what ends this turn.
        { energySpeechThreshold: 0.05, silenceHangoverMs: 60_000, maxUtteranceMs: 2000 },
        makeSessionFactory(makeOrtSession([])),
      );
      await svc.initialize();
      const ends: number[] = [];
      svc.subscribe(() => {}, () => ends.push(1));

      svc.feedFrame(LOUD);
      await drain();

      jest.advanceTimersByTime(2500);
      svc.feedFrame(LOUD);
      await drain();

      expect(ends).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('re-arms after the ceiling so the next speaker is still heard', async () => {
    jest.useFakeTimers();
    try {
      const svc = new SileroVadService(
        { energySpeechThreshold: 0.05, silenceHangoverMs: 60_000, maxUtteranceMs: 2000 },
        makeSessionFactory(makeOrtSession([])),
      );
      await svc.initialize();
      const starts: number[] = [];
      svc.subscribe(() => starts.push(1), () => {});

      svc.feedFrame(LOUD);
      await drain();
      jest.advanceTimersByTime(2500);
      svc.feedFrame(LOUD); // hits the ceiling, ends the turn
      await drain();

      svc.feedFrame(LOUD); // the next thing anybody says
      await drain();

      expect(starts).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
