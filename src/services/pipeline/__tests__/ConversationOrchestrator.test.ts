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
} from '../ConversationOrchestrator';
import { useConversationStore } from '../../../store/conversationStore';

// ── Helper mocks ─────────────────────────────────────────────────────────────

interface VoxtralCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string, language?: string) => void;
  onError: (err: Error) => void;
}

function makeMocks() {
  const audioCapture: jest.Mocked<AudioCapture> = {
    requestPermission: jest.fn().mockResolvedValue(true),
    startStreaming: jest.fn(),
    stopStreaming: jest.fn().mockResolvedValue(undefined),
  };

  let voxtralCallbacks: VoxtralCallbacks | null = null;
  const voxtral: jest.Mocked<VoxtralLike> = {
    start: jest.fn().mockImplementation(async (_opts, cbs: VoxtralCallbacks) => {
      voxtralCallbacks = cbs;
    }),
    feedAudio: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn(),
  };

  const ttsCalls: { text: string; language: string }[] = [];
  const tts: jest.Mocked<TTSLike> = {
    init: jest.fn().mockResolvedValue(undefined),
    prewarm: jest.fn(),
    speakChunk: jest.fn().mockImplementation((text: string, language: string) => {
      ttsCalls.push({ text, language });
      return Promise.resolve();
    }),
    stop: jest.fn(),
  };

  const translator: jest.Mocked<TranslatorLike> = {
    prewarm: jest.fn().mockResolvedValue(undefined),
    translateStream: jest.fn(),
  };

  return {
    audioCapture,
    voxtral,
    tts,
    translator,
    ttsCalls,
    fireVoxtralPartial: (text: string) => voxtralCallbacks?.onPartial(text),
    fireVoxtralFinal: (text: string) => voxtralCallbacks?.onFinal(text),
    fireVoxtralError: (msg: string) => voxtralCallbacks?.onError(new Error(msg)),
  };
}

beforeEach(() => {
  useConversationStore.getState().clear();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ConversationOrchestrator', () => {
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

    // beginTurn returns a Promise that resolves at end-of-turn; we'll await
    // it after firing the simulated downstream events.
    const turnPromise = o.beginTurn({
      speakerId: 'person_a',
      sourceLang: 'es',
      targetLang: 'en',
    });
    await Promise.resolve(); // let microtasks settle

    expect(m.audioCapture.startStreaming).toHaveBeenCalledTimes(1);
    expect(m.voxtral.start).toHaveBeenCalledTimes(1);
    expect(o.getState()).toBe('recording');

    // Simulate live partials
    m.fireVoxtralPartial('hola');
    m.fireVoxtralPartial('hola mundo');
    expect(useConversationStore.getState().turns[0].sourceText).toBe('hola mundo');

    // Wire translator: it'll be called when we fire the final
    m.translator.translateStream.mockImplementation(async (args) => {
      args.onFirstToken?.();
      args.onSentence('Hello world.');
      args.onDone('Hello world.');
    });

    // User releases PTT
    await o.endTurn();
    expect(m.audioCapture.stopStreaming).toHaveBeenCalled();
    expect(m.voxtral.end).toHaveBeenCalled();

    // Voxtral fires final
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
    // CRITICAL: activeTurnId must clear so the next mic press isn't blocked.
    expect(state.activeTurnId).toBeNull();
  });

  it('clears activeTurnId after empty-transcription turn', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    const turnPromise = o.beginTurn({
      speakerId: 'person_a',
      sourceLang: 'es',
      targetLang: 'en',
    });
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

    // Defer TTS chunk resolution so we can verify orchestrator waits.
    const ttsResolvers: Array<() => void> = [];
    m.tts.speakChunk.mockImplementation((text, language) => {
      m.ttsCalls.push({ text, language });
      return new Promise<void>((resolve) => {
        ttsResolvers.push(resolve);
      });
    });

    m.translator.translateStream.mockImplementation(async (args) => {
      args.onSentence('First sentence.');
      args.onSentence('Second sentence.');
      args.onDone('First sentence. Second sentence.');
    });

    const turnPromise = o.beginTurn({
      speakerId: 'person_a',
      sourceLang: 'es',
      targetLang: 'en',
    });
    await Promise.resolve();
    await o.endTurn();
    m.fireVoxtralFinal('texto fuente');

    // Let microtasks run to enqueue TTS chunks
    await new Promise((r) => setTimeout(r, 0));
    expect(m.ttsCalls).toHaveLength(2);

    // Turn shouldn't be done yet — TTS still pending
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

    const turnPromise = o.beginTurn({
      speakerId: 'person_a',
      sourceLang: 'es',
      targetLang: 'en',
    });
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

    const turnPromise = o.beginTurn({
      speakerId: 'person_a',
      sourceLang: 'es',
      targetLang: 'en',
    });
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

    const turnPromise = o.beginTurn({
      speakerId: 'person_a',
      sourceLang: 'es',
      targetLang: 'en',
    });
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

    // Second call should silently no-op
    const t2 = o.beginTurn({ speakerId: 'person_b', sourceLang: 'en', targetLang: 'es' });
    await Promise.resolve();

    expect(m.audioCapture.startStreaming).toHaveBeenCalledTimes(1);

    // Cleanup — finish first turn
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

  it('cancelTurn aborts an in-flight turn', async () => {
    const m = makeMocks();
    const o = new ConversationOrchestrator(m);
    o.configure({ apiKey: 'sk', translationModel: 'mistral-small-latest' });

    const turnPromise = o.beginTurn({
      speakerId: 'person_a',
      sourceLang: 'es',
      targetLang: 'en',
    });
    await Promise.resolve();

    await o.cancelTurn();
    await turnPromise;

    expect(m.voxtral.cancel).toHaveBeenCalled();
    expect(m.tts.stop).toHaveBeenCalled();
    expect(o.getState()).toBe('idle');
    const turn = useConversationStore.getState().turns[0];
    expect(turn.stage).toBe('error');
    expect(turn.errorMessage).toContain('cancelled');
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

    // Once at beginTurn, again on onFirstToken
    expect(m.tts.prewarm).toHaveBeenCalledTimes(2);
  });
});
