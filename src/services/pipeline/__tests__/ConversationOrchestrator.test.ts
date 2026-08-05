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

  const voxtral: jest.Mocked<VoxtralLike> = {
    start: jest.fn().mockImplementation(async (_opts, cbs: VoxtralCallbacks) => {
      voxtralCallbacks = cbs;
    }),
    feedAudio: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn(),
    endSession: jest.fn().mockResolvedValue(undefined),
    resetUtterance: jest.fn(),
    flushUtterance: jest.fn().mockImplementation(() => {
      return new Promise<{ text: string; language?: string }>((resolve) => {
        flushResolver = resolve;
      });
    }),
  };

  const ttsCalls: { text: string; language: string }[] = [];
  const tts: jest.Mocked<TTSLike> = {
    init: jest.fn().mockResolvedValue(undefined),
    prewarm: jest.fn(),
    speakChunk: jest.fn().mockImplementation((text: string, language: string) => {
      ttsCalls.push({ text, language });
      return Promise.resolve<TTSSpeakOutcome>('spoken');
    }),
    stop: jest.fn(),
  };

  const translator: jest.Mocked<TranslatorLike> = {
    prewarm: jest.fn().mockResolvedValue(undefined),
    translateStream: jest.fn(),
  };

  let vadStart: (() => void) | null = null;
  let vadEnd: (() => void) | null = null;
  const vad: jest.Mocked<VadLike> = {
    initialize: jest.fn().mockResolvedValue(undefined),
    feedFrame: jest.fn(),
    subscribe: jest.fn().mockImplementation((onStart, onEnd) => {
      vadStart = onStart;
      vadEnd = onEnd;
      return () => { vadStart = null; vadEnd = null; };
    }),
    setActive: jest.fn(),
    resetState: jest.fn(),
    destroy: jest.fn(),
  };

  return {
    audioCapture,
    voxtral,
    tts,
    translator,
    ttsCalls,
    vad,
    fireVoxtralPartial: (text: string) => voxtralCallbacks?.onPartial(text),
    fireVoxtralFinal: (text: string, lang?: string) => voxtralCallbacks?.onFinal(text, lang),
    fireVoxtralError: (msg: string) => voxtralCallbacks?.onError(new Error(msg)),
    fireVadStart: () => vadStart?.(),
    fireVadEnd: () => vadEnd?.(),
    resolveFlush: (text: string, language?: string) => {
      flushResolver?.({ text, language });
      flushResolver = null;
    },
  };
}

beforeEach(() => {
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
