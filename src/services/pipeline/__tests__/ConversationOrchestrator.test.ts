jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
}));

import {
  ConversationOrchestrator,
  type AudioCapture,
  type VoxtralLike,
  type TranslatorLike,
  type TTSLike,
  type TTSSpeakOutcome,
  type VadLike,
} from '../ConversationOrchestrator';
import { useConversationStore } from '../../../store/conversationStore';
import { getAudioLevel, resetAudioLevel } from '../../audio/audioLevelBus';
import { log } from '../../log/logStore';

/** One 512-sample VAD frame of a sine at `amplitude` (0..1), base64 PCM16. */
function pcmFrame(amplitude: number): string {
  const pcm = new Int16Array(512);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.round(amplitude * 32767 * Math.sin(i * 0.19));
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ── Helper mocks ─────────────────────────────────────────────────────────────

interface VoxtralCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string, language?: string) => void;
  onError: (err: Error) => void;
}

type FlushResolver = (result: { text: string; language?: string }) => void;

function makeMocks() {
  const audioCapture: jest.Mocked<AudioCapture> = {
    hasPermission: jest.fn().mockResolvedValue(true),
    requestPermission: jest.fn().mockResolvedValue(true),
    startStreaming: jest.fn(),
    stopStreaming: jest.fn().mockResolvedValue(undefined),
  };

  let voxtralCallbacks: VoxtralCallbacks | null = null;
  let flushResolver: FlushResolver | null = null;
  let flushInFlight: Promise<{ text: string; language?: string }> | null = null;
  // Mirrors the real client's accumulator: partials build it up, and either
  // flushUtterance or commitUtterance hands it over and clears it.
  let accumulated = '';
  let accumulatedLang: string | undefined;

  const voxtral: jest.Mocked<VoxtralLike> = {
    start: jest.fn().mockImplementation(async (_opts, cbs: VoxtralCallbacks) => {
      voxtralCallbacks = cbs;
    }),
    feedAudio: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn(),
    endSession: jest.fn().mockResolvedValue(undefined),
    resetUtterance: jest.fn().mockImplementation(() => {
      accumulated = '';
      accumulatedLang = undefined;
    }),
    commitUtterance: jest.fn().mockImplementation(() => {
      const taken = { text: accumulated, language: accumulatedLang };
      accumulated = '';
      accumulatedLang = undefined;
      return taken;
    }),
    flushUtterance: jest.fn().mockImplementation(() => {
      // Mirrors the real client: asking while a flush is outstanding JOINS it.
      // The segment is already closed, and one transcription.done answers both
      // callers — which is what lets the orchestrator flush speculatively at
      // the pause hint and then ask again for real without bookkeeping.
      if (flushInFlight) return flushInFlight;
      flushInFlight = new Promise<{ text: string; language?: string }>((resolve) => {
        flushResolver = resolve;
      });
      return flushInFlight;
    }),
  };

  const ttsCalls: { text: string; language: string }[] = [];
  const tts: jest.Mocked<TTSLike> = {
    init: jest.fn().mockResolvedValue(undefined),
    prewarm: jest.fn(),
    presetVoice: jest.fn(),
    speakChunk: jest
      .fn()
      .mockImplementation((text: string, language: string, onStart?: () => void) => {
        ttsCalls.push({ text, language });
        onStart?.();
        return Promise.resolve<TTSSpeakOutcome>('spoken');
      }),
    stop: jest.fn(),
  };

  const translator: jest.Mocked<TranslatorLike> = {
    prewarm: jest.fn().mockResolvedValue(undefined),
    translateStream: jest.fn(),
  };

  let vadStart: (() => void) | null = null;
  let vadEnd: ((lastSpeechAt: number) => void) | null = null;
  let vadPause: ((lastSpeechAt: number) => void) | null = null;
  let vadResume: (() => void) | null = null;
  const vad: jest.Mocked<VadLike> = {
    initialize: jest.fn().mockResolvedValue(undefined),
    feedFrame: jest.fn(),
    subscribe: jest.fn().mockImplementation((onStart, onEnd, onPause, onResume) => {
      vadStart = onStart;
      vadEnd = onEnd;
      vadPause = onPause ?? null;
      vadResume = onResume ?? null;
      return () => {
        vadStart = null; vadEnd = null; vadPause = null; vadResume = null;
      };
    }),
    setActive: jest.fn(),
    resetState: jest.fn(),
    endUtterance: jest.fn(),
    destroy: jest.fn(),
  };

  return {
    audioCapture,
    voxtral,
    tts,
    translator,
    ttsCalls,
    vad,
    fireVoxtralPartial: (text: string, lang?: string) => {
      accumulated = text;
      if (lang !== undefined) accumulatedLang = lang;
      voxtralCallbacks?.onPartial(text);
    },
    fireVoxtralFinal: (text: string, lang?: string) => voxtralCallbacks?.onFinal(text, lang),
    fireVoxtralError: (msg: string) => voxtralCallbacks?.onError(new Error(msg)),
    fireVadStart: () => vadStart?.(),
    fireVadEnd: (lastSpeechAt = Date.now()) => vadEnd?.(lastSpeechAt),
    fireVadPause: (lastSpeechAt = Date.now()) => vadPause?.(lastSpeechAt),
    fireVadResume: () => vadResume?.(),
    resolveFlush: (text: string, language?: string) => {
      accumulated = '';
      accumulatedLang = undefined;
      flushResolver?.({ text, language });
      flushResolver = null;
      flushInFlight = null;
    },
  };
}

beforeEach(() => {
  resetAudioLevel();
  useConversationStore.getState().clear();
  useConversationStore.getState().setMode('ptt');
  useConversationStore.getState().setHfActiveSpeaker(null);
  useConversationStore.getState().setHfUnroutedSpeaker(null);
});

// ── PTT tests ─────────────────────────────────────────────────────────────────

describe('ConversationOrchestrator (PTT)', () => {
  it('refuses beginTurn without configure() (missing api key)', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    await expect(
      o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' }),
    ).rejects.toThrow(/missing API key/i);
  });

  it('starts in idle, transitions through recording → transcribing → translating → idle', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    expect(o.getState()).toBe('idle');

    const turnPromise = o.beginTurn({
      speakerId: 'person_a',
      sourceLang: 'es',
      targetLang: 'en',
    });
    await Promise.resolve();

    expect(m.audioCapture.startStreaming).toHaveBeenCalledTimes(1);
    expect(m.voxtral.start).toHaveBeenCalledTimes(1);
    expect(o.getState()).toBe('recording');

    m.fireVoxtralPartial('hola');
    m.fireVoxtralPartial('hola mundo');
    expect(useConversationStore.getState().turns[0].sourceText).toBe('hola mundo');

    m.translator.translateStream.mockImplementation(async (args) => {
      args.onFirstToken?.();
      args.onSentence('Hello world.');
      args.onDone('Hello world.');
    });

    await o.endTurn();
    expect(m.audioCapture.stopStreaming).toHaveBeenCalled();
    expect(m.voxtral.end).toHaveBeenCalled();

    m.fireVoxtralFinal('hola mundo');
    await turnPromise;

    expect(o.getState()).toBe('idle');
    expect(m.translator.translateStream).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk',
        sourceText: 'hola mundo',
        sourceLang: 'es',
        targetLang: 'en',
        model: 'mistral-small-latest',
      }),
    );
    expect(m.ttsCalls).toEqual([{ text: 'Hello world.', language: 'en' }]);
    const state = useConversationStore.getState();
    expect(state.turns[0].stage).toBe('done');
    expect(state.turns[0].translatedText).toBe('Hello world.');
    expect(state.activeTurnId).toBeNull();
  });

  it('clears activeTurnId after empty-transcription turn', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    const turnPromise = o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' });
    await Promise.resolve();
    expect(useConversationStore.getState().activeTurnId).not.toBeNull();
    await o.endTurn();
    m.fireVoxtralFinal('   ');
    await turnPromise;

    expect(useConversationStore.getState().activeTurnId).toBeNull();
  });

  it('queues multiple TTS chunks and awaits all before completing', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    const ttsResolvers: Array<() => void> = [];
    m.tts.speakChunk.mockImplementation((text, language) => {
      m.ttsCalls.push({ text, language });
      return new Promise<TTSSpeakOutcome>((resolve) => {
        ttsResolvers.push(() => resolve('spoken'));
      });
    });

    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('First sentence.');
      args.onSentence('Second sentence.');
      args.onDone('First sentence. Second sentence.');
    });

    const turnPromise = o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' });
    await Promise.resolve();
    await o.endTurn();
    m.fireVoxtralFinal('texto fuente');

    await new Promise((r) => setTimeout(r, 0));
    expect(m.ttsCalls).toHaveLength(2);
    expect(o.getState()).toBe('speaking');

    ttsResolvers.forEach((r) => r());
    await turnPromise;
    expect(o.getState()).toBe('idle');
    expect(useConversationStore.getState().turns[0].stage).toBe('done');
  });

  it('marks turn as error and releases lock on translator failure', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    m.translator.translateStream.mockImplementation(async (args) => {
      args.onError(new Error('HTTP 401: Authentication failed'));
    });

    const turnPromise = o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' });
    await Promise.resolve();
    await o.endTurn();
    m.fireVoxtralFinal('hola');
    await turnPromise;

    expect(o.getState()).toBe('idle');
    const turn = useConversationStore.getState().turns[0];
    expect(turn.stage).toBe('error');
    expect(turn.errorMessage).toContain('401');
  });

  it('fails turn cleanly when Voxtral fires an error mid-recording', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    const turnPromise = o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' });
    await Promise.resolve();
    expect(o.getState()).toBe('recording');

    m.fireVoxtralError('WebSocket closed unexpectedly');
    await turnPromise;

    expect(o.getState()).toBe('idle');
    expect(useConversationStore.getState().turns[0].stage).toBe('error');
  });

  it('handles empty transcription as a clean no-op turn', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    const turnPromise = o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' });
    await Promise.resolve();
    await o.endTurn();
    m.fireVoxtralFinal('   ');
    await turnPromise;

    expect(m.translator.translateStream).not.toHaveBeenCalled();
    expect(m.tts.speakChunk).not.toHaveBeenCalled();
    expect(useConversationStore.getState().turns[0].stage).toBe('done');
  });

  it('rejects a second beginTurn while a turn is in flight', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    const t1 = o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' });
    await Promise.resolve();

    const t2 = o.beginTurn({ speakerId: 'person_b', sourceLang: 'en', targetLang: 'es' });
    await Promise.resolve();

    expect(m.audioCapture.startStreaming).toHaveBeenCalledTimes(1);

    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('done.');
      args.onDone('done.');
    });
    await o.endTurn();
    m.fireVoxtralFinal('algo');
    await t1;
    await t2;
  });

  it('prewarm() initializes TTS and pings translator', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    await o.prewarm();
    expect(m.tts.init).toHaveBeenCalled();
    expect(m.translator.prewarm).toHaveBeenCalledWith({
      apiKey: 'sk',
      model: 'mistral-small-latest',
    });
  });

  it('cancelTurn aborts an in-flight turn quietly (done, no error, no notice)', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    const turnPromise = o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' });
    await Promise.resolve();

    await o.cancelTurn();
    await turnPromise;

    expect(m.voxtral.cancel).toHaveBeenCalled();
    expect(m.tts.stop).toHaveBeenCalled();
    expect(o.getState()).toBe('idle');
    const state = useConversationStore.getState();
    // User intent is not a failure: no error stage (would fire the error
    // haptic), no notice pane.
    expect(state.turns[0].stage).toBe('done');
    expect(state.notices.person_a).toBeNull();
  });

  it('surfaces a speaker-side notice when the turn fails (humanized, keyed)', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    m.translator.translateStream.mockImplementation(async (args) => {
      args.onError(new Error('HTTP 401: Authentication failed (check API key).'));
    });

    const turnPromise = o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' });
    await Promise.resolve();
    await o.endTurn();
    m.fireVoxtralFinal('hola');
    await turnPromise;

    const state = useConversationStore.getState();
    // Notice lands on the SPEAKER's half (person_a spoke), as a key — the UI
    // renders it in the speaker's language; raw text stays in the log.
    expect(state.notices.person_a).toEqual({ key: 'keyInvalid', kind: 'error' });
    expect(state.notices.person_b).toBeNull();
  });

  it('empty transcript sets a quiet didntCatch notice for the speaker', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    const turnPromise = o.beginTurn({ speakerId: 'person_b', sourceLang: 'en', targetLang: 'es' });
    await Promise.resolve();
    await o.endTurn();
    m.fireVoxtralFinal('   ');
    await turnPromise;

    expect(useConversationStore.getState().notices.person_b).toEqual({
      key: 'didntCatch',
      kind: 'info',
    });
  });

  it('a fresh press clears the speaker\'s previous notice', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });
    useConversationStore.getState().setNotice('person_a', { key: 'generic', kind: 'error' });

    const turnPromise = o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' });
    await Promise.resolve();
    expect(useConversationStore.getState().notices.person_a).toBeNull();

    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('Hello world.');
      args.onDone('Hello world.');
    });
    await o.endTurn();
    m.fireVoxtralFinal('hola');
    await turnPromise;
  });

  it('denied mic permission never starts a turn and notifies the speaker', async () => {
    const m = makeMocks();
    m.audioCapture.hasPermission.mockResolvedValue(false);
    m.audioCapture.requestPermission.mockResolvedValue(false);
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    await o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' });

    expect(m.audioCapture.startStreaming).not.toHaveBeenCalled();
    expect(useConversationStore.getState().turns).toHaveLength(0);
    expect(useConversationStore.getState().notices.person_a).toEqual({
      key: 'micPermission',
      kind: 'info',
    });
    expect(o.getState()).toBe('idle');
  });

  it('streams translation deltas into translatedText before any sentence completes', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    m.translator.translateStream.mockImplementation(async (args) => {
      args.onDelta?.('Hel');
      // Second delta inside the throttle window is allowed to be skipped;
      // what matters is text is visible LONG before the sentence boundary.
      expect(useConversationStore.getState().turns[0].translatedText).toBe('Hel');
      args.onSentence('Hello world.');
      args.onDone('Hello world.');
    });

    const turnPromise = o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' });
    await Promise.resolve();
    await o.endTurn();
    m.fireVoxtralFinal('hola');
    await turnPromise;

    expect(useConversationStore.getState().turns[0].translatedText).toBe('Hello world.');
  });

  it('fires speculative TTS prewarm at beginTurn AND on first translation token', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    m.translator.translateStream.mockImplementation(async (args) => {
      args.onFirstToken?.();
      args.onSentence('Hi.');
      args.onDone('Hi.');
    });

    const t = o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' });
    await Promise.resolve();
    expect(m.tts.prewarm).toHaveBeenCalledWith('en');

    await o.endTurn();
    m.fireVoxtralFinal('hola');
    await t;

    expect(m.tts.prewarm).toHaveBeenCalledTimes(2);
  });
});

// ── Hands-free tests ──────────────────────────────────────────────────────────

describe('ConversationOrchestrator (hands-free)', () => {
  function makeHfOrchestrator() {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });
    return { m, o };
  }

  async function enableHf(m: ReturnType<typeof makeMocks>, o: ConversationOrchestrator) {
    const enablePromise = o.enableHandsFree('es', 'en');
    await enablePromise;
    return enablePromise;
  }

  it('enables HF: initializes VAD, starts audio and Voxtral session', async () => {
    const { m, o } = makeHfOrchestrator();
    await enableHf(m, o);

    expect(m.vad.initialize).toHaveBeenCalledTimes(1);
    expect(m.audioCapture.startStreaming).toHaveBeenCalledTimes(1);
    expect(m.voxtral.start).toHaveBeenCalledWith(
      expect.objectContaining({ sessionMode: true }),
      expect.any(Object),
    );
    expect(m.vad.subscribe).toHaveBeenCalledTimes(1);
    expect(useConversationStore.getState().mode).toBe('hf');
    expect(o.isHandsFreeActive()).toBe(true);
  });

  it('denied mic permission never enables HF and notifies both halves', async () => {
    const { m, o } = makeHfOrchestrator();
    m.audioCapture.hasPermission.mockResolvedValue(false);
    m.audioCapture.requestPermission.mockResolvedValue(false);

    await o.enableHandsFree('es', 'en');

    expect(m.audioCapture.startStreaming).not.toHaveBeenCalled();
    expect(m.voxtral.start).not.toHaveBeenCalled();
    expect(m.vad.initialize).not.toHaveBeenCalled();
    expect(o.isHandsFreeActive()).toBe(false);
    expect(useConversationStore.getState().mode).toBe('ptt');
    expect(useConversationStore.getState().notices.person_a).toEqual({
      key: 'micPermission',
      kind: 'info',
    });
    expect(useConversationStore.getState().notices.person_b).toEqual({
      key: 'micPermission',
      kind: 'info',
    });
  });

  it('grant-on-request proceeds into hands-free', async () => {
    const { m, o } = makeHfOrchestrator();
    m.audioCapture.hasPermission.mockResolvedValue(false);
    m.audioCapture.requestPermission.mockResolvedValue(true);

    await o.enableHandsFree('es', 'en');

    expect(m.audioCapture.requestPermission).toHaveBeenCalledTimes(1);
    expect(m.audioCapture.startStreaming).toHaveBeenCalledTimes(1);
    expect(o.isHandsFreeActive()).toBe(true);
  });

  it('routes A→B when VAD fires and flush returns lang matching pair A', async () => {
    const { m, o } = makeHfOrchestrator();
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('Hello.');
      args.onDone('Hello.');
    });

    await enableHf(m, o);

    m.fireVadStart();
    m.fireVadEnd();

    // Resolve flush with Spanish text — should route person_a (es) → person_b (en)
    await Promise.resolve();
    m.resolveFlush('hola mundo', 'es');
    await new Promise<void>(r => setTimeout(r, 50));

    const turns = useConversationStore.getState().turns;
    const hfTurn = turns.find(t => t.sourceText === 'hola mundo');
    expect(hfTurn).toBeDefined();
    expect(hfTurn?.speakerId).toBe('person_a');
    expect(hfTurn?.sourceLang).toBe('es');
    expect(hfTurn?.targetLang).toBe('en');
  });

  it('routes B→A when flush returns lang matching pair B', async () => {
    const { m, o } = makeHfOrchestrator();
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('Hola.');
      args.onDone('Hola.');
    });

    await enableHf(m, o);

    m.fireVadStart();
    m.fireVadEnd();

    await Promise.resolve();
    m.resolveFlush('Good morning', 'en');
    await new Promise<void>(r => setTimeout(r, 50));

    const turns = useConversationStore.getState().turns;
    const hfTurn = turns.find(t => t.sourceText === 'Good morning');
    expect(hfTurn).toBeDefined();
    expect(hfTurn?.speakerId).toBe('person_b');
    expect(hfTurn?.sourceLang).toBe('en');
    expect(hfTurn?.targetLang).toBe('es');
  });

  it('discards utterance when lang is not in pair', async () => {
    const { m, o } = makeHfOrchestrator();
    await enableHf(m, o);

    m.fireVadStart();
    m.fireVadEnd();

    await Promise.resolve();
    // Flush with Italian — not in es/en pair
    m.resolveFlush('Buongiorno', 'it');
    await new Promise<void>(r => setTimeout(r, 50));

    const turns = useConversationStore.getState().turns;
    expect(turns).toHaveLength(0);
    expect(useConversationStore.getState().hfUnroutedSpeaker).not.toBeNull();
    expect(m.translator.translateStream).not.toHaveBeenCalled();
  });

  it('uses alternating fallback when no language tag', async () => {
    const { m, o } = makeHfOrchestrator();
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('ok');
      args.onDone('ok');
    });

    await enableHf(m, o);

    // First utterance without language tag → defaults to person_a
    m.fireVadStart();
    m.fireVadEnd();
    await Promise.resolve();
    m.resolveFlush('test utterance', undefined);
    await new Promise<void>(r => setTimeout(r, 100));

    const turns = useConversationStore.getState().turns;
    expect(turns[0].speakerId).toBe('person_a');
  });

  it('routes by the transcript when the audio language tag is wrong (same-language echo fix)', async () => {
    const { m, o } = makeHfOrchestrator();
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('Hi, how are you doing?');
      args.onDone('Hi, how are you doing?');
    });

    await enableHf(m, o);

    m.fireVadStart();
    m.fireVadEnd();
    await Promise.resolve();
    // Voxtral mis-tags clearly-Spanish speech as English. Trusting the tag
    // would translate en→es and parrot the Spanish back at the speaker —
    // the transcript's own language must win.
    m.resolveFlush('Hola, ¿qué tal estás?', 'en');
    await new Promise<void>(r => setTimeout(r, 50));

    const hfTurn = useConversationStore
      .getState()
      .turns.find(t => t.sourceText === 'Hola, ¿qué tal estás?');
    expect(hfTurn).toBeDefined();
    expect(hfTurn?.speakerId).toBe('person_a');
    expect(hfTurn?.sourceLang).toBe('es');
    expect(hfTurn?.targetLang).toBe('en');
    const call = m.translator.translateStream.mock.calls[0][0];
    expect(call.sourceLang).toBe('es');
    expect(call.targetLang).toBe('en');
  });

  it('routes by the transcript when the tag is missing instead of blindly alternating', async () => {
    const { m, o } = makeHfOrchestrator();
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('ok');
      args.onDone('ok');
    });

    await enableHf(m, o);

    // Turn 1: Spanish, tagged — routes person_a and completes.
    m.fireVadStart();
    m.fireVadEnd();
    await Promise.resolve();
    m.resolveFlush('hola mundo', 'es');
    await new Promise<void>(r => setTimeout(r, 350)); // turn + 250 ms cooldown

    // Turn 2: the SAME person keeps talking, tag missing. Blind alternation
    // would flip to person_b (en→es) and parrot the Spanish; the transcript
    // keeps it person_a.
    m.fireVadStart();
    m.fireVadEnd();
    await Promise.resolve();
    m.resolveFlush('Muy bien, gracias', undefined);
    await new Promise<void>(r => setTimeout(r, 350)); // let the cooldown timer drain

    const t2 = useConversationStore
      .getState()
      .turns.find(t => t.sourceText === 'Muy bien, gracias');
    expect(t2).toBeDefined();
    expect(t2?.speakerId).toBe('person_a');
    expect(t2?.sourceLang).toBe('es');
    expect(t2?.targetLang).toBe('en');
  });

  it('rescues an utterance whose audio tag is outside the pair when the transcript matches a side', async () => {
    const { m, o } = makeHfOrchestrator();
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('Where is the train station?');
      args.onDone('Where is the train station?');
    });

    await enableHf(m, o);

    m.fireVadStart();
    m.fireVadEnd();
    await Promise.resolve();
    // Voxtral occasionally hears Catalan in Spanish speech. The old router
    // discarded the whole utterance; the transcript claims it for person_a.
    m.resolveFlush('¿Dónde está la estación de tren?', 'ca');
    await new Promise<void>(r => setTimeout(r, 50));

    const hfTurn = useConversationStore
      .getState()
      .turns.find(t => t.sourceText === '¿Dónde está la estación de tren?');
    expect(hfTurn).toBeDefined();
    expect(hfTurn?.speakerId).toBe('person_a');
    expect(hfTurn?.sourceLang).toBe('es');
    expect(hfTurn?.targetLang).toBe('en');
    expect(useConversationStore.getState().hfUnroutedSpeaker).toBeNull();
  });

  it('streams live partials into hfLive with the classifier-guessed side, and clears on dispatch', async () => {
    const { m, o } = makeHfOrchestrator();
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('Hi, how are you?');
      args.onDone('Hi, how are you?');
    });

    await enableHf(m, o);

    // While the speaker is still talking, partials must reach the screen —
    // a long monologue with a dead display reads as a hung app.
    m.fireVadStart();
    m.fireVoxtralPartial('Hola, ¿qué tal estás?');
    const live = useConversationStore.getState().hfLive;
    expect(live).not.toBeNull();
    expect(live?.text).toBe('Hola, ¿qué tal estás?');
    expect(live?.side).toBe('person_a'); // clearly-Spanish text → pair side A

    m.fireVadEnd();
    await Promise.resolve();
    m.resolveFlush('Hola, ¿qué tal estás?', 'es');
    await new Promise<void>(r => setTimeout(r, 50));

    // The routed turn takes over — the live partial's job is done.
    expect(useConversationStore.getState().hfLive).toBeNull();
  });

  it('skipHfTurn() cuts a long readback: stops TTS, ends the turn as done, no error notice', async () => {
    const { m, o } = makeHfOrchestrator();

    let ttsResolve: (() => void) | undefined;
    m.tts.speakChunk.mockImplementation(
      () => new Promise<TTSSpeakOutcome>(r => { ttsResolve = () => r('spoken'); }),
    );
    // The real TTS service resolves in-flight chunks on stop(); mirror that.
    m.tts.stop.mockImplementation(() => { ttsResolve?.(); });

    m.translator.translateStream.mockImplementation(async (args) => {
      args.onDelta?.('A very long translated readback.');
      args.onSentence('A very long translated readback.');
      // Stream keeps going until the reader aborts it.
      await new Promise<void>((resolve) => {
        args.signal?.addEventListener('abort', () => {
          args.onError(new Error('Translation cancelled'));
          resolve();
        });
      });
    });

    await enableHf(m, o);

    m.fireVadStart();
    m.fireVadEnd();
    await Promise.resolve();
    m.resolveFlush('una parrafada muy larga', 'es');
    await new Promise<void>(r => setTimeout(r, 20));
    expect(o.getHfState()).toBe('hf-speaking');

    o.skipHfTurn();
    await new Promise<void>(r => setTimeout(r, 350)); // dispatch tail + cooldown

    expect(m.tts.stop).toHaveBeenCalled();
    const turn = useConversationStore
      .getState()
      .turns.find(t => t.sourceText === 'una parrafada muy larga');
    // A reader-initiated skip is a normal ending, not a failure.
    expect(turn?.stage).toBe('done');
    expect(turn?.translatedText).toBe('A very long translated readback.');
    expect(useConversationStore.getState().notices.person_a).toBeNull();
    expect(useConversationStore.getState().notices.person_b).toBeNull();
    // The machine listens again.
    expect(o.getHfState()).toBe('hf-idle');
    expect(o.isHandsFreeActive()).toBe(true);
  });

  it('scales the flush wait with capture duration (never below the 3 s base)', async () => {
    const { m, o } = makeHfOrchestrator();
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('Hello.');
      args.onDone('Hello.');
    });

    await enableHf(m, o);

    m.fireVadStart();
    m.fireVadEnd();
    await Promise.resolve();
    m.resolveFlush('hola', 'es');
    await new Promise<void>(r => setTimeout(r, 50));

    const timeoutArg = (m.voxtral.flushUtterance as jest.Mock).mock.calls[0][0] as number;
    expect(timeoutArg).toBeGreaterThanOrEqual(3_000);
    expect(timeoutArg).toBeLessThanOrEqual(10_000);
  });

  it('gates VAD during TTS playback', async () => {
    const { m, o } = makeHfOrchestrator();

    let ttsResolve: (() => void) | undefined;
    m.tts.speakChunk.mockImplementation(
      () => new Promise<TTSSpeakOutcome>(r => { ttsResolve = () => r('spoken'); }),
    );

    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('Hello.');
      args.onDone('Hello.');
    });

    await enableHf(m, o);

    m.fireVadStart();
    m.fireVadEnd();
    await Promise.resolve();
    m.resolveFlush('hola', 'es');
    await new Promise<void>(r => setTimeout(r, 20));

    // TTS is playing — VAD should be gated
    expect(m.vad.setActive).toHaveBeenCalledWith(false);

    // Resolve TTS
    ttsResolve?.();
    await new Promise<void>(r => setTimeout(r, 300)); // cooldown

    // After cooldown, VAD should be re-enabled
    expect(m.vad.setActive).toHaveBeenCalledWith(true);
  });

  it('stops feeding Voxtral while HF speaks, and scrubs the accumulator on re-arm (echo gate)', async () => {
    const { m, o } = makeHfOrchestrator();

    let ttsResolve: (() => void) | undefined;
    m.tts.speakChunk.mockImplementation(
      () => new Promise<TTSSpeakOutcome>(r => { ttsResolve = () => r('spoken'); }),
    );
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('Hello.');
      args.onDone('Hello.');
    });

    await enableHf(m, o);
    const onData = m.audioCapture.startStreaming.mock.calls[0][0] as (b64: string) => void;

    m.fireVadStart();
    m.fireVadEnd();
    await Promise.resolve();
    m.resolveFlush('hola', 'es');
    await new Promise<void>(r => setTimeout(r, 20));

    // hf-speaking: the mic is hearing the phone's own TTS — none of it may
    // reach the Voxtral session.
    m.voxtral.feedAudio.mockClear();
    onData('AAAA');
    expect(m.voxtral.feedAudio).not.toHaveBeenCalled();

    ttsResolve?.();
    await new Promise<void>(r => setTimeout(r, 300)); // cooldown elapses

    // Re-armed: leaked partial state was scrubbed, feed is live again.
    expect(m.voxtral.resetUtterance).toHaveBeenCalled();
    onData('AAAA');
    expect(m.voxtral.feedAudio).toHaveBeenCalled();
  });

  it('drives the audio level meter from live mic frames, and stops at silence', async () => {
    const { m, o } = makeHfOrchestrator();
    await enableHf(m, o);
    const onData = m.audioCapture.startStreaming.mock.calls[0][0] as (b64: string) => void;

    expect(getAudioLevel()).toBe(0);

    for (let i = 0; i < 10; i++) onData(pcmFrame(0.3));
    const loud = getAudioLevel();
    expect(loud).toBeGreaterThan(0.5);

    for (let i = 0; i < 10; i++) onData(pcmFrame(0.001));
    expect(getAudioLevel()).toBeLessThan(loud);
  });

  it('never lets the meter visualise the phone’s own TTS', async () => {
    const { m, o } = makeHfOrchestrator();

    let ttsResolve: (() => void) | undefined;
    m.tts.speakChunk.mockImplementation(
      () => new Promise<TTSSpeakOutcome>(r => { ttsResolve = () => r('spoken'); }),
    );
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('Hello.');
      args.onDone('Hello.');
    });

    await enableHf(m, o);
    const onData = m.audioCapture.startStreaming.mock.calls[0][0] as (b64: string) => void;

    // A real utterance lights the meter up.
    for (let i = 0; i < 10; i++) onData(pcmFrame(0.3));
    expect(getAudioLevel()).toBeGreaterThan(0.5);

    m.fireVadStart();
    m.fireVadEnd();
    await Promise.resolve();
    m.resolveFlush('hola', 'es');
    await new Promise<void>(r => setTimeout(r, 20));

    // hf-speaking: the meter drops the instant the phone takes the floor, and
    // the loud audio the mic now hears (its own speaker) moves nothing.
    expect(getAudioLevel()).toBe(0);
    for (let i = 0; i < 10; i++) onData(pcmFrame(0.5));
    expect(getAudioLevel()).toBe(0);

    ttsResolve?.();
    await new Promise<void>(r => setTimeout(r, 300)); // cooldown elapses

    // Re-armed: the room drives the wave again.
    for (let i = 0; i < 10; i++) onData(pcmFrame(0.3));
    expect(getAudioLevel()).toBeGreaterThan(0.5);
  });

  it('pauseHandsFree and disableHandsFree leave the meter at rest', async () => {
    const { m, o } = makeHfOrchestrator();
    await enableHf(m, o);
    const onData = m.audioCapture.startStreaming.mock.calls[0][0] as (b64: string) => void;

    for (let i = 0; i < 10; i++) onData(pcmFrame(0.3));
    await o.pauseHandsFree();
    expect(getAudioLevel()).toBe(0);

    await o.resumeHandsFree();
    for (let i = 0; i < 10; i++) onData(pcmFrame(0.3));
    expect(getAudioLevel()).toBeGreaterThan(0.5);

    await o.disableHandsFree();
    expect(getAudioLevel()).toBe(0);
  });

  it('disableHandsFree() cleans up VAD, audio, Voxtral and resets store', async () => {
    const { m, o } = makeHfOrchestrator();
    await enableHf(m, o);

    await o.disableHandsFree();

    expect(m.audioCapture.stopStreaming).toHaveBeenCalled();
    expect(m.voxtral.endSession).toHaveBeenCalled();
    expect(useConversationStore.getState().mode).toBe('ptt');
    expect(useConversationStore.getState().hfActiveSpeaker).toBeNull();
    expect(o.isHandsFreeActive()).toBe(false);
  });

  it('ignores beginTurn while HF is active', async () => {
    const { m, o } = makeHfOrchestrator();
    await enableHf(m, o);

    // beginTurn should be ignored silently
    await o.beginTurn({ speakerId: 'person_a', sourceLang: 'es', targetLang: 'en' });

    // PTT should not have started audio capture again (only once from enableHF)
    expect(m.audioCapture.startStreaming).toHaveBeenCalledTimes(1);
  });

  it('throws when enableHandsFree is called without VAD dep', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator({
      ...m,
      vad: undefined,
    });
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    await expect(o.enableHandsFree('es', 'en')).rejects.toThrow(/No VAD/i);
  });

  it('sets hfActiveSpeaker on the store during routing', async () => {
    const { m, o } = makeHfOrchestrator();

    let translationResolve: (() => void) | undefined;
    m.translator.translateStream.mockImplementation(async (args) => {
      await new Promise<void>(r => { translationResolve = r; });
      args.onSentence('Hello.');
      args.onDone('Hello.');
    });

    await enableHf(m, o);

    m.fireVadStart();
    m.fireVadEnd();
    await Promise.resolve();
    m.resolveFlush('hola', 'es');
    await new Promise<void>(r => setTimeout(r, 20));

    // Should be set to person_a while translating
    expect(useConversationStore.getState().hfActiveSpeaker).toBe('person_a');

    translationResolve?.();
    await new Promise<void>(r => setTimeout(r, 300));

    // Should clear after cooldown
    expect(useConversationStore.getState().hfActiveSpeaker).toBeNull();
  });

  it('routes correctly with BCP-47 regional pair (es vs es-MX would be ambiguous; en-US vs es matches symmetrically)', async () => {
    const { m, o } = makeHfOrchestrator();
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('Hello.');
      args.onDone('Hello.');
    });

    // Pair: en-US (person_a) ↔ es (person_b). Voxtral may emit 'en' or 'en-US'.
    const enablePromise = o.enableHandsFree('en-US', 'es');
    await enablePromise;

    m.fireVadStart();
    m.fireVadEnd();
    await Promise.resolve();
    // Detected as plain 'en' — primary subtag matches en-US.
    m.resolveFlush('Hello there', 'en');
    await new Promise<void>(r => setTimeout(r, 50));

    const turns = useConversationStore.getState().turns;
    expect(turns[0].speakerId).toBe('person_a');
    expect(turns[0].sourceLang).toBe('en-US');
    expect(turns[0].targetLang).toBe('es');
  });

  it('re-enable after mid-flight disable rearms VAD (no permanent gating)', async () => {
    const { m, o } = makeHfOrchestrator();
    await enableHf(m, o);

    // Disable while idle (simulates user mashing the toggle).
    await o.disableHandsFree();
    expect(m.vad.setActive).toHaveBeenCalledWith(false);

    // Re-enable.
    m.vad.setActive.mockClear();
    await o.enableHandsFree('es', 'en');

    // VAD must be re-armed after subscribe so it isn't silently dead.
    expect(m.vad.setActive).toHaveBeenCalledWith(true);
  });

  it('flush rejection triggers reconnect: pauses VAD, restarts Voxtral, re-arms VAD', async () => {
    const { m, o } = makeHfOrchestrator();
    await enableHf(m, o);

    // After enable: voxtral.start called once, vad.setActive(true) called once.
    expect(m.voxtral.start).toHaveBeenCalledTimes(1);

    // Force the next flush to fail.
    (m.voxtral.flushUtterance as jest.Mock).mockRejectedValueOnce(new Error('flush timeout'));

    m.fireVadStart();
    m.fireVadEnd();

    // Wait for the rejection + 500ms reconnect delay + the reconnect microtask.
    await new Promise<void>((r) => setTimeout(r, 600));

    // VAD was paused during reconnect.
    expect(m.vad.setActive).toHaveBeenCalledWith(false);

    // Voxtral was restarted (initial enable + reconnect = 2 calls).
    expect(m.voxtral.start).toHaveBeenCalledTimes(2);

    // The reconnect call must be in sessionMode.
    expect(m.voxtral.start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionMode: true }),
      expect.any(Object),
    );

    // After successful reconnect, VAD was re-armed.
    expect(m.vad.setActive).toHaveBeenCalledWith(true);

    // HF is still active.
    expect(o.isHandsFreeActive()).toBe(true);
  });

  it('disables HF cleanly when reconnect itself fails after a flush rejection', async () => {
    const { m, o } = makeHfOrchestrator();
    await enableHf(m, o);

    // First flush fails.
    (m.voxtral.flushUtterance as jest.Mock).mockRejectedValueOnce(new Error('flush timeout'));
    // Reconnect attempt also fails — second call to voxtral.start rejects.
    // The first call (during enableHandsFree) already resolved, so we use
    // mockRejectedValueOnce here, and it will apply to the next (reconnect) call.
    m.voxtral.start.mockRejectedValueOnce(new Error('reconnect refused'));

    m.fireVadStart();
    m.fireVadEnd();

    // Wait for: rejection → 500ms delay → second start rejects → disableHandsFree.
    await new Promise<void>((r) => setTimeout(r, 700));

    // Cleanup happened.
    expect(m.audioCapture.stopStreaming).toHaveBeenCalled();

    // Mode reverted to PTT.
    expect(useConversationStore.getState().mode).toBe('ptt');

    // HF flag is cleared.
    expect(o.isHandsFreeActive()).toBe(false);
  });

  it('reconnect pauses VAD before the new Voxtral session opens (drains stale buffer)', async () => {
    const { m, o } = makeHfOrchestrator();
    await enableHf(m, o);

    // Capture the invocation order baseline so we can compare AFTER the reconnect.
    const startCallsBefore = m.voxtral.start.mock.invocationCallOrder.length;
    const setActiveCallsBefore = m.vad.setActive.mock.invocationCallOrder.length;

    // Flush rejects → triggers attemptHfReconnect.
    (m.voxtral.flushUtterance as jest.Mock).mockRejectedValueOnce(new Error('flush timeout'));

    // Drive the state machine into hf-capturing then end.
    m.fireVadStart();
    m.fireVadEnd();

    // Wait for the full reconnect cycle (500 ms delay + start).
    await new Promise<void>((r) => setTimeout(r, 600));

    // Find the order index of the first vad.setActive(false) call that happened
    // AFTER enable, and the second voxtral.start call (the reconnect).
    const setActiveOrders = m.vad.setActive.mock.invocationCallOrder;
    const setActiveArgs = m.vad.setActive.mock.calls;
    const startOrders = m.voxtral.start.mock.invocationCallOrder;

    // The reconnect's voxtral.start is the call AFTER the enable's start.
    expect(startOrders.length).toBeGreaterThan(startCallsBefore);
    const reconnectStartOrder = startOrders[startCallsBefore];

    // Find a vad.setActive(false) call whose order is BEFORE reconnectStartOrder.
    let pauseOrder: number | undefined;
    for (let i = setActiveCallsBefore; i < setActiveOrders.length; i++) {
      if (setActiveArgs[i][0] === false && setActiveOrders[i] < reconnectStartOrder) {
        pauseOrder = setActiveOrders[i];
        break;
      }
    }

    // VAD was paused (setActive(false)) BEFORE the reconnect's voxtral.start fired.
    expect(pauseOrder).toBeDefined();
    expect(pauseOrder!).toBeLessThan(reconnectStartOrder);
  });
});

// ── Latency: the two shortcuts out of a turn ─────────────────────────────────
//
// Both trade a wait for evidence, and both must refuse when the evidence is
// thin. The tests below pin the refusals as hard as the shortcuts: a turn that
// arrives fast on the wrong half, or missing its last word, is worse than a
// turn that arrives late.

describe('ConversationOrchestrator (hands-free latency)', () => {
  function makeHfOrchestrator() {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk-test', translationModel: 'mistral-small-latest' });
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onFirstToken?.();
      args.onSentence('Good morning.');
      args.onDone('Good morning.');
    });
    return { m, o };
  }

  /** Let the streamed transcript go quiet for longer than PARTIAL_SETTLED_MS. */
  const settle = () => new Promise<void>(r => setTimeout(r, 200));

  it('dispatches from the settled transcript without waiting for the server final', async () => {
    const { m, o } = makeHfOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    m.fireVoxtralPartial('Buenos días, ¿qué tal estás?');
    await settle();
    m.fireVadEnd();
    await new Promise<void>(r => setTimeout(r, 50));

    // The round trip was closed in the background, never awaited.
    expect(m.voxtral.commitUtterance).toHaveBeenCalledTimes(1);
    expect(m.voxtral.flushUtterance).not.toHaveBeenCalled();

    const turn = useConversationStore.getState().turns.at(-1);
    expect(turn?.sourceText).toBe('Buenos días, ¿qué tal estás?');
    expect(turn?.speakerId).toBe('person_a');
    expect(turn?.targetLang).toBe('en');
    expect(m.ttsCalls[0]).toEqual({ text: 'Good morning.', language: 'en' });
  });

  it('waits for the server final when the transcript is still arriving', async () => {
    const { m, o } = makeHfOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    m.fireVoxtralPartial('Buenos días, ¿qué tal');
    // No settle: a delta landed just now, so the sentence may still be growing
    // and its tail is exactly what the fast path would drop.
    m.fireVadEnd();
    await Promise.resolve();

    expect(m.voxtral.flushUtterance).toHaveBeenCalledTimes(1);
    expect(m.voxtral.commitUtterance).not.toHaveBeenCalled();

    m.resolveFlush('Buenos días, ¿qué tal estás?', 'es');
    await new Promise<void>(r => setTimeout(r, 50));
    expect(useConversationStore.getState().turns.at(-1)?.sourceText).toBe(
      'Buenos días, ¿qué tal estás?',
    );
  });

  it('waits for the server final when the transcript alone cannot route the turn', async () => {
    const { m, o } = makeHfOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    // Settled and punctuated, but a bare proper noun belongs to neither
    // language — without the final there is no audio tag to fall back on.
    m.fireVoxtralPartial('Barcelona.');
    await settle();
    m.fireVadEnd();
    await Promise.resolve();

    expect(m.voxtral.commitUtterance).not.toHaveBeenCalled();
    expect(m.voxtral.flushUtterance).toHaveBeenCalledTimes(1);
  });

  it('ends the turn on the pause hint once the transcript closes a sentence', async () => {
    const { m, o } = makeHfOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    m.fireVoxtralPartial('Buenos días, ¿qué tal estás?');
    await settle();
    m.fireVadPause();
    await new Promise<void>(r => setTimeout(r, 50));

    // The turn ran without the hangover ever expiring...
    expect(useConversationStore.getState().turns.at(-1)?.sourceText).toBe(
      'Buenos días, ¿qué tal estás?',
    );
    // ...and the hangover was cancelled, so it cannot deliver a second ending.
    expect(m.vad.endUtterance).toHaveBeenCalledTimes(1);

    // A late speech_end for the same utterance changes nothing.
    const turnsBefore = useConversationStore.getState().turns.length;
    m.fireVadEnd();
    await new Promise<void>(r => setTimeout(r, 20));
    expect(useConversationStore.getState().turns.length).toBe(turnsBefore);
  });

  it('ignores the pause hint mid-sentence — that is what the hangover is for', async () => {
    const { m, o } = makeHfOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    // A breath after a clause. Ending here would split the utterance, and the
    // half spoken next is lost behind the readback of the first.
    m.fireVoxtralPartial('Buenos días, quería preguntarte');
    await settle();
    m.fireVadPause();
    await new Promise<void>(r => setTimeout(r, 20));

    expect(m.vad.endUtterance).not.toHaveBeenCalled();
    expect(m.voxtral.commitUtterance).not.toHaveBeenCalled();
    expect(o.getHfState()).toBe('hf-capturing');
    expect(useConversationStore.getState().turns).toHaveLength(0);
  });

  it('warms both voices of the pair at enable, before anyone has spoken', async () => {
    const { m, o } = makeHfOrchestrator();
    await o.enableHandsFree('es', 'en');

    const warmed = m.tts.prewarm.mock.calls.map(c => c[0]);
    expect(warmed).toContain('es');
    expect(warmed).toContain('en');
  });

  it('reports the wait from real silence to real audio, not from the hangover', async () => {
    const { m, o } = makeHfOrchestrator();
    await o.enableHandsFree('es', 'en');

    const lines: string[] = [];
    const spy = jest.spyOn(log, 'info').mockImplementation((msg: string) => { lines.push(msg); });

    m.fireVadStart();
    m.fireVoxtralPartial('Buenos días, ¿qué tal estás?');
    await settle();
    // Silence began 600 ms before the VAD conceded the turn.
    m.fireVadEnd(Date.now() - 600);
    await new Promise<void>(r => setTimeout(r, 50));
    spy.mockRestore();

    const emitted = lines.find(l => l.startsWith('[hf_turn]'));
    expect(emitted).toBeDefined();
    const payload = JSON.parse(emitted!.replace('[hf_turn] ', ''));
    expect(payload.transcript).toBe('settled-partial');
    expect(payload.endpoint).toBe('silence');
    // The hangover is counted as part of the wait, because the listener waited
    // through it. Measuring from vadEnd would hide the largest fixed cost.
    expect(payload.endpointDelay).toBeGreaterThanOrEqual(590);
    expect(payload.speechEndToAudio).toBeGreaterThanOrEqual(payload.endpointDelay);
    // The round trip we removed shows up as ~0, not as a missing field.
    expect(payload.flushToFinal).toBeLessThan(20);
  });
});

// ── Translating ahead of the ending ──────────────────────────────────────────
//
// The request to Mistral is the longest link in the chain, so it is sent on the
// transcript we already have while the endpointer is still waiting out silence.
// The safety is entirely in adoption: a turn takes the running stream only if
// it is a translation of that utterance, in that direction. Everything else is
// discarded unread, which is what these tests are mostly about.

type TranslateArgs = Parameters<TranslatorLike['translateStream']>[0];

describe('ConversationOrchestrator (translating ahead of the ending)', () => {
  function makeSpecOrchestrator() {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk-test', translationModel: 'mistral-small-latest' });
    const streams: TranslateArgs[] = [];
    m.translator.translateStream.mockImplementation(
      (args: TranslateArgs) =>
        new Promise<void>(() => { streams.push(args); }), // never self-resolves
    );
    return { m, o, streams };
  }

  const settle = () => new Promise<void>(r => setTimeout(r, 200));
  const tick = () => new Promise<void>(r => setTimeout(r, 30));

  /** Speak a stable, clearly-Spanish transcript that does NOT close a
   *  sentence, so the pause hint speculates without ending the turn. */
  const OPEN_UTTERANCE = 'Buenos días, quería preguntarte una cosa';

  it('sends the translation at the pause hint, and the turn adopts it', async () => {
    const { m, o, streams } = makeSpecOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    m.fireVoxtralPartial(OPEN_UTTERANCE);
    await settle();
    m.fireVadPause();
    await tick();

    // In flight while the speaker still owns the turn.
    expect(streams).toHaveLength(1);
    expect(streams[0].sourceText).toBe(OPEN_UTTERANCE);
    expect(streams[0].targetLang).toBe('en');
    // …and nothing has reached the listener yet.
    expect(m.ttsCalls).toHaveLength(0);
    expect(useConversationStore.getState().turns).toHaveLength(0);

    // Tokens arrive before the utterance is even declared over.
    streams[0].onFirstToken?.();
    streams[0].onSentence('Good morning, I wanted to ask you something.');
    expect(m.ttsCalls).toHaveLength(0); // still buffered — nothing is certain

    m.fireVadEnd();
    await tick();

    // The turn took the running stream rather than starting a second request.
    expect(m.translator.translateStream).toHaveBeenCalledTimes(1);
    expect(m.ttsCalls).toEqual([
      { text: 'Good morning, I wanted to ask you something.', language: 'en' },
    ]);
    expect(useConversationStore.getState().turns.at(-1)?.sourceText).toBe(OPEN_UTTERANCE);
  });

  it('adopts across the tidying the final applies — punctuation and accents', async () => {
    const { m, o, streams } = makeSpecOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    m.fireVoxtralPartial('buenos dias quería preguntarte una cosa');
    await settle();
    m.fireVadPause();
    await tick();
    expect(streams).toHaveLength(1);

    // The server's final says the same words, dressed properly.
    (m.voxtral.commitUtterance as jest.Mock).mockReturnValueOnce({
      text: 'Buenos días, ¿quería preguntarte una cosa?',
      language: 'es',
    });
    m.fireVadEnd();
    await tick();

    expect(m.translator.translateStream).toHaveBeenCalledTimes(1);
  });

  it('discards the guess when the speaker kept going', async () => {
    const { m, o, streams } = makeSpecOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    m.fireVoxtralPartial(OPEN_UTTERANCE);
    await settle();
    m.fireVadPause();
    await tick();
    expect(streams).toHaveLength(1);
    const guessed = streams[0];
    guessed.onSentence('Good morning, I wanted to ask you something.');

    // They were not finished.
    m.fireVoxtralPartial(`${OPEN_UTTERANCE} sobre el tren`);
    await settle();
    m.fireVadEnd();
    await tick();

    // The stale stream was abandoned and a correct one started.
    expect(guessed.signal?.aborted).toBe(true);
    expect(m.translator.translateStream).toHaveBeenCalledTimes(2);
    expect(streams[1].sourceText).toBe(`${OPEN_UTTERANCE} sobre el tren`);
    // Nothing from the discarded guess was ever spoken.
    expect(m.ttsCalls).toHaveLength(0);
  });

  it('discards the guess when the turn turned out to travel the other way', async () => {
    const { m, o, streams } = makeSpecOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    m.fireVoxtralPartial(OPEN_UTTERANCE);
    await settle();
    m.fireVadPause();
    await tick();
    expect(streams[0].targetLang).toBe('en');

    // The final is English after all — same-ish text, opposite direction.
    (m.voxtral.commitUtterance as jest.Mock).mockReturnValueOnce({
      text: 'Good morning, I wanted to ask you something',
      language: 'en',
    });
    m.fireVadEnd();
    await tick();

    expect(streams[0].signal?.aborted).toBe(true);
    expect(m.translator.translateStream).toHaveBeenCalledTimes(2);
    expect(streams[1].targetLang).toBe('es');
  });

  it('stops guessing after a couple of misses in one utterance', async () => {
    const { m, o } = makeSpecOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    for (const tail of ['una cosa', 'una cosa sobre', 'una cosa sobre el tren']) {
      m.fireVoxtralPartial(`Buenos días, quería preguntarte ${tail}`);
      await settle();
      m.fireVadPause();
      await tick();
    }

    // Every miss is a real request against the user's own key and rate limit.
    expect(m.translator.translateStream.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('never guesses on speaker alternation — that is not evidence about this utterance', async () => {
    const { m, o } = makeSpecOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    // A bare proper noun: the classifier abstains, so routing would be a coin
    // flip that the real ending could easily overturn.
    m.fireVoxtralPartial('Barcelona Sants');
    await settle();
    m.fireVadPause();
    await tick();

    expect(m.translator.translateStream).not.toHaveBeenCalled();
  });

  it('drops an in-flight guess when hands-free is switched off', async () => {
    const { m, o, streams } = makeSpecOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    m.fireVoxtralPartial(OPEN_UTTERANCE);
    await settle();
    m.fireVadPause();
    await tick();
    expect(streams).toHaveLength(1);

    await o.disableHandsFree();

    expect(streams[0].signal?.aborted).toBe(true);
  });
});

// ── Acting when the transcript arrives, not when a timer says so ─────────────
//
// The first device measurements showed every shortcut declining. Two causes,
// both pinned here: the pause hint asked its question before Voxtral had
// delivered the words, and the routing gate held out for an audio language tag
// that this server never sends.

describe('ConversationOrchestrator (waiting for evidence, not for clocks)', () => {
  function makeOrchestrator() {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk-test', translationModel: 'mistral-small-latest' });
    const streams: TranslateArgs[] = [];
    m.translator.translateStream.mockImplementation((args: TranslateArgs) => {
      streams.push(args);
      return new Promise<void>(() => {});
    });
    return { m, o, streams };
  }

  const tick = () => new Promise<void>(r => setTimeout(r, 40));
  const settle = () => new Promise<void>(r => setTimeout(r, 220));
  const SPANISH = 'Buenos días, quería preguntarte una cosa';

  it('holds the pause hint open until the words actually land', async () => {
    const { m, o, streams } = makeOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    m.fireVoxtralPartial(SPANISH);
    // The hint arrives while that delta is still warm — Voxtral buffers audio,
    // so silence in the room does not mean the sentence has been delivered.
    m.fireVadPause();
    await tick();
    expect(streams).toHaveLength(0);

    // It goes quiet: now we know what was said, and only now do we act.
    await settle();
    expect(streams).toHaveLength(1);
    expect(streams[0].sourceText).toBe(SPANISH);
  });

  it('drops everything the hint started when the speaker carries on', async () => {
    const { m, o, streams } = makeOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    m.fireVoxtralPartial(SPANISH);
    m.fireVadPause();
    m.fireVadResume();
    await settle();

    expect(streams).toHaveLength(0);
    expect(o.getHfState()).toBe('hf-capturing');
  });

  it('stops holding out for an audio tag the server never sends', async () => {
    const { m, o } = makeOrchestrator();
    m.translator.translateStream.mockImplementation(async (args: TranslateArgs) => {
      args.onSentence('Hello.');
      args.onDone('Hello.');
    });
    await o.enableHandsFree('es', 'en');

    // 'Hola.' is Spanish on a single signal — a weak vote, which normally
    // defers to the audio tag as a second opinion.
    const speak = async () => {
      m.fireVadStart();
      m.fireVoxtralPartial('Hola.');
      await settle();
      m.fireVadEnd();
      await Promise.resolve();
      m.resolveFlush('Hola.'); // no language — as observed on device
      await new Promise<void>(r => setTimeout(r, 350));
    };

    await speak();
    await speak();
    // Two utterances, no tag either time: the second opinion is not coming.
    expect(m.voxtral.flushUtterance).toHaveBeenCalledTimes(2);
    expect(m.voxtral.commitUtterance).not.toHaveBeenCalled();

    await speak();
    // Same weak evidence, now acted on — it is what routing falls back to
    // anyway once the tag is absent.
    expect(m.voxtral.commitUtterance).toHaveBeenCalledTimes(1);
    expect(m.voxtral.flushUtterance).toHaveBeenCalledTimes(2);
  });

  it('goes strict again the moment a tag does arrive', async () => {
    const { m, o } = makeOrchestrator();
    m.translator.translateStream.mockImplementation(async (args: TranslateArgs) => {
      args.onSentence('Hello.');
      args.onDone('Hello.');
    });
    await o.enableHandsFree('es', 'en');

    // Two untagged utterances unlock the shortcut.
    for (let i = 0; i < 2; i++) {
      m.fireVadStart();
      m.fireVoxtralPartial('Hola.');
      await settle();
      m.fireVadEnd();
      await Promise.resolve();
      m.resolveFlush('Hola.');
      await new Promise<void>(r => setTimeout(r, 350));
    }

    // The next one takes the shortcut — and the server tags it after all.
    // Voxtral sends `transcription.language` mid-stream, so the shortcut can
    // still see a tag; it does not have to give up watching to go faster.
    m.fireVadStart();
    m.fireVoxtralPartial('Hola.', 'es');
    await settle();
    m.fireVadEnd();
    await new Promise<void>(r => setTimeout(r, 350));
    expect(m.voxtral.commitUtterance).toHaveBeenCalledTimes(1);

    // The second opinion is real after all, so weak evidence defers again.
    m.fireVadStart();
    m.fireVoxtralPartial('Hola.');
    await settle();
    m.fireVadEnd();
    await Promise.resolve();
    expect(m.voxtral.commitUtterance).toHaveBeenCalledTimes(1);
    expect(m.voxtral.flushUtterance).toHaveBeenCalledTimes(3);
  });
});

// ── Asking for the transcript instead of waiting to be offered it ────────────
//
// A conversation is mostly short turns, and for a short utterance Voxtral
// streams no delta at all: every word arrives in the final. Waiting for the
// hangover before asking for that final meant the words existed nowhere for
// ~850 ms after the speaker stopped, and every shortcut declined for want of a
// transcript. The flush now goes out at the pause hint, so the round trip runs
// *during* the silence instead of after it.

describe('ConversationOrchestrator (asking for the transcript, not waiting for it)', () => {
  function makeHfOrchestrator() {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk-test', translationModel: 'mistral-small-latest' });
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onFirstToken?.();
      args.onSentence('Good morning.');
      args.onDone('Good morning.');
    });
    return { m, o };
  }

  const tick = () => new Promise<void>(r => setTimeout(r, 30));
  const settle = () => new Promise<void>(r => setTimeout(r, 200));
  const turnDone = () => new Promise<void>(r => setTimeout(r, 80));

  it('ends the turn on a final it asked for at the pause hint, with no delta ever streamed', async () => {
    const { m, o } = makeHfOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    // Not a single partial: this is what a short utterance actually looks
    // like, and it is why every shortcut used to decline as 'no-transcript'.
    m.fireVadPause();
    await tick();
    expect(m.voxtral.flushUtterance).toHaveBeenCalledTimes(1);

    m.resolveFlush('Buenos días, ¿qué tal estás?', 'es');
    await turnDone();

    // The hangover never expired — the punctuated final ended the turn — and
    // the round trip that ended it was the one sent during the silence.
    expect(m.vad.endUtterance).toHaveBeenCalledTimes(1);
    expect(m.voxtral.flushUtterance).toHaveBeenCalledTimes(1);
    expect(useConversationStore.getState().turns.at(-1)?.sourceText).toBe(
      'Buenos días, ¿qué tal estás?',
    );
  });

  it('has the transcript already in hand when the hangover expires', async () => {
    const { m, o } = makeHfOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    m.fireVadPause();
    await tick();
    // An unfinished thought: no full stop, so this must NOT end the turn.
    m.resolveFlush('Buenos días, quería preguntarte una cosa', 'es');
    await tick();
    expect(o.getHfState()).toBe('hf-capturing');
    expect(m.vad.endUtterance).not.toHaveBeenCalled();

    m.fireVadEnd();
    await turnDone();

    // The ending cost no round trip of its own: the answer was already here.
    expect(m.voxtral.flushUtterance).toHaveBeenCalledTimes(1);
    expect(useConversationStore.getState().turns.at(-1)?.sourceText).toBe(
      'Buenos días, quería preguntarte una cosa',
    );
  });

  it('joins what is spoken next onto the segment the early flush closed', async () => {
    const { m, o } = makeHfOrchestrator();
    await o.enableHandsFree('es', 'en');

    m.fireVadStart();
    m.fireVadPause();
    await tick();
    m.resolveFlush('Buenos días, quería preguntarte', 'es');
    await tick();

    // The speaker was only drawing breath. Closing the segment early must not
    // cost them the rest of the sentence — the words after it stream into a
    // fresh segment and are stitched back on.
    m.fireVadResume();
    m.fireVoxtralPartial('una cosa importante');
    await settle();
    m.fireVadEnd();
    await turnDone();

    expect(useConversationStore.getState().turns.at(-1)?.sourceText).toBe(
      'Buenos días, quería preguntarte una cosa importante',
    );
  });

  it('reports where the transcript came from, so a shortcut cannot fail silently', async () => {
    const { m, o } = makeHfOrchestrator();
    await o.enableHandsFree('es', 'en');
    const lines: string[] = [];
    const spy = jest.spyOn(log, 'info').mockImplementation((msg: string) => { lines.push(msg); });

    m.fireVadStart();
    m.fireVadPause();
    await tick();
    m.resolveFlush('Buenos días, ¿qué tal estás?', 'es');
    await turnDone();
    spy.mockRestore();

    const emitted = lines.find(l => l.startsWith('[hf_turn]'));
    expect(emitted).toBeDefined();
    const payload = JSON.parse(emitted!.replace('[hf_turn] ', ''));
    expect(payload.earlyFlush).toBe('used');
    expect(payload.endpoint).toBe('punctuation');
    // The round trip happened inside the silence, so it is reported but is not
    // part of the wait — the ending's own flush cost nothing.
    expect(payload.earlyFlushMs).toBeGreaterThanOrEqual(0);
    expect(payload.flushToFinal).toBeLessThan(20);
  });

  it('selects the other voice during the cooldown, because a conversation alternates', async () => {
    const { m, o } = makeHfOrchestrator();
    await o.enableHandsFree('es', 'en');
    m.tts.prewarm.mockClear();

    m.fireVadStart();
    m.fireVoxtralPartial('Buenos días, ¿qué tal estás?');
    await settle();
    m.fireVadEnd();
    await new Promise<void>(r => setTimeout(r, 400)); // past HF_COOLDOWN_MS

    // The turn was read out in English; the reply will need Spanish.
    expect(m.tts.presetVoice).toHaveBeenCalledWith('es');
    // And the cooldown SELECTS rather than warms. A silent primer is a real
    // synth-and-play cycle: queued between turns it sits in the native queue
    // ahead of the reply, and measured on device that roughly tripled the
    // next sentence's time to audio. (Warming the voice being spoken *now*,
    // which is what the calls during the turn are, stays as it was.)
    expect(m.tts.prewarm).not.toHaveBeenCalledWith('es');
  });
});
