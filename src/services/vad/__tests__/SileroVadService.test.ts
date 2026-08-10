/**
 * SileroVadService tests — ONNX runtime and RNFS fully mocked.
 */

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
}));

// Mock ONNX Runtime and RNFS via require() since the service uses require().
jest.mock('onnxruntime-react-native', () => ({
  InferenceSession: {
    create: jest.fn(),
  },
  Tensor: jest.fn().mockImplementation((type, data, dims) => ({ type, data, dims })),
}), { virtual: true });

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/data/user/0/com.parly/files',
  MainBundlePath: '/bundle',
  exists: jest.fn().mockResolvedValue(true),
  copyFileAssets: jest.fn().mockResolvedValue(undefined),
  copyFile: jest.fn().mockResolvedValue(undefined),
}), { virtual: true });

import { SileroVadService, VAD_FRAME_SAMPLES, type OrtSession, type OrtTensor } from '../SileroVadService';

// ── Mock ONNX session ─────────────────────────────────────────────────────────

function makeOrtSession(speechProbSequence: number[]): OrtSession {
  let callIndex = 0;
  return {
    run: jest.fn().mockImplementation(async () => {
      const prob = speechProbSequence[callIndex] ?? 0;
      callIndex++;
      return {
        output: { data: new Float32Array([prob]) } as OrtTensor,
        stateN: { data: new Float32Array(256) } as OrtTensor,
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
