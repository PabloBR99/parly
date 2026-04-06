/**
 * Conversation simulation — mirrors how you'd manually test the app:
 * open it, two people alternate speaking in different languages,
 * and the app should route + translate each turn correctly.
 *
 * Each turn asserts:
 *  1. Speaker assigned correctly (person_a / person_b)
 *  2. Translation direction correct (sourceLang → targetLang)
 *  3. STT called with the right arguments (language hint or not)
 *
 * Run with:  npx jest src/services/pipeline/__tests__/ConversationSimulation
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('react-native', () => ({ Platform: { OS: 'android' }, NativeModules: {} }));
jest.mock('nanoid/non-secure', () => ({ nanoid: () => 'test-id' }));

jest.mock('../../stt/WhisperService', () => ({
  whisperService: { transcribe: jest.fn() },
}));

jest.mock('../../stt/CanaryService', () => ({
  canaryService: {
    isReady: false,
    isLoadedFor: jest.fn().mockReturnValue(false),
    transcribeBoth: jest.fn().mockResolvedValue(null),
    release: jest.fn().mockResolvedValue(undefined),
    loadForPair: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../translation/TranslationServiceSingleton', () => ({
  getTranslationService: jest.fn(),
}));

jest.mock('../../tts/ZipVoiceService', () => ({
  zipvoiceService: { isReady: false, synthesize: jest.fn() },
}));
jest.mock('../../tts/NativeTTSService', () => ({
  nativeTTSService: { speak: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../tts/AudioPlayerService', () => ({
  audioPlayerService: { play: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../../utils/audioUtils', () => ({
  readWavAsVoiceRef: jest.fn().mockResolvedValue(null),
}));
jest.mock('../UtteranceQueue', () => ({
  UtteranceQueue: jest.fn().mockImplementation(() => ({
    setHandler: jest.fn(),
    enqueue: jest.fn(),
    isProcessing: false,
  })),
}));
jest.mock('../../../store/conversationStore', () => ({
  useConversationStore: {
    getState: jest.fn().mockReturnValue({
      addMessage: jest.fn(),
      updateMessage: jest.fn(),
      setPipelineStage: jest.fn(),
      removeMessage: jest.fn(),
    }),
  },
}));
jest.mock('../../../store/modelStore', () => ({
  useModelStore: { getState: jest.fn().mockReturnValue({ zipvoiceStatus: 'idle' }) },
}));
jest.mock('../../../store/settingsStore', () => ({
  useSettingsStore: { getState: jest.fn() },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { whisperService } from '../../stt/WhisperService';
import { resolveAutoUtterance, resetDiscovery } from '../PipelineOrchestrator';

// ── Shared mock service ───────────────────────────────────────────────────────

const mockSvc = {
  identifyLanguage: jest.fn<Promise<{ language: string; confidence: number }[]>, [string]>(),
  translate: jest.fn().mockResolvedValue({ text: '[translated]' }),
  downloadLanguagePair: jest.fn().mockResolvedValue(undefined),
};

beforeAll(() => {
  const { getTranslationService } = jest.requireMock(
    '../../translation/TranslationServiceSingleton',
  );
  getTranslationService.mockResolvedValue(mockSvc);
});

beforeEach(() => {
  resetDiscovery();
  jest.clearAllMocks();
  const { getTranslationService } = jest.requireMock(
    '../../translation/TranslationServiceSingleton',
  );
  getTranslationService.mockResolvedValue(mockSvc);
  mockSvc.downloadLanguagePair.mockResolvedValue(undefined);
  mockSvc.translate.mockResolvedValue({ text: '[translated]' });
  setupSettings();
});

// ── Live settings mock (tracks setPersonLanguage calls, mirrors real Zustand) ──

let settingsPersonALang = 'es';
let settingsPersonBLang = 'en';

function setupSettings(personALang = 'es', personBLang = 'en') {
  settingsPersonALang = personALang;
  settingsPersonBLang = personBLang;
  const { useSettingsStore } = jest.requireMock('../../../store/settingsStore');
  useSettingsStore.getState.mockImplementation(() => ({
    personA: { language: settingsPersonALang, voice: 'casual_male', displayName: 'Persona A' },
    personB: { language: settingsPersonBLang, voice: 'casual_female', displayName: 'Persona B' },
    inputMode: 'vad',
    autoPlay: false,
    ttsNumSteps: 5,
    // Mirrors the real store: updates are reflected in subsequent getState() calls
    setPersonLanguage: (personId: string, lang: string) => {
      if (personId === 'person_a') settingsPersonALang = lang;
      else settingsPersonBLang = lang;
    },
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function speak(text: string, detectedLang: string, confidence: number) {
  (whisperService.transcribe as jest.Mock).mockResolvedValueOnce({ text });
  mockSvc.identifyLanguage.mockResolvedValueOnce([{ language: detectedLang, confidence }]);
}

function lastTranscribeArgs() {
  const calls = (whisperService.transcribe as jest.Mock).mock.calls;
  return calls[calls.length - 1] ?? [];
}

// ── Simulations ───────────────────────────────────────────────────────────────

describe('Conversation simulation: Spanish ↔ English', () => {
  /**
   * Full 6-turn conversation:
   *  Turn 1 — A speaks es (DISCOVERING_A → DISCOVERING_B)
   *  Turn 2 — B speaks en (DISCOVERING_B → ACTIVE)
   *  Turn 3 — A speaks es (ACTIVE, confirmed)
   *  Turn 4 — B speaks en (ACTIVE, confirmed)
   *  Turn 5 — A speaks es (ACTIVE, stays correct)
   *  Turn 6 — B speaks en (ACTIVE, stays correct)
   */
  it('routes every turn correctly and STT is called exactly once per turn without language hint', async () => {
    const conversation = [
      // Phase: DISCOVERING_A
      {
        turn: 1, audio: 'turn1.wav',
        speech: 'Buenos días, ¿cómo estás hoy?',   // 26 chars ≥ 15
        detectedLang: 'es', confidence: 0.92,
        expected: { speaker: 'person_a', src: 'es', tgt: 'en' },
        note: 'DISCOVERING_A → commits langA=es',
      },
      // Phase: DISCOVERING_B
      {
        turn: 2, audio: 'turn2.wav',
        speech: 'Good morning, nice to meet you!',  // 31 chars ≥ 15
        detectedLang: 'en', confidence: 0.91,
        expected: { speaker: 'person_b', src: 'en', tgt: 'es' },
        note: 'DISCOVERING_B → commits langB=en, enters ACTIVE',
      },
      // Phase: ACTIVE
      {
        turn: 3, audio: 'turn3.wav',
        speech: '¿De dónde eres tú?',
        detectedLang: 'es', confidence: 0.88,
        expected: { speaker: 'person_a', src: 'es', tgt: 'en' },
        note: 'ACTIVE — es detected → person_a → translate es→en',
      },
      {
        turn: 4, audio: 'turn4.wav',
        speech: 'I am from London, born and raised.',
        detectedLang: 'en', confidence: 0.87,
        expected: { speaker: 'person_b', src: 'en', tgt: 'es' },
        note: 'ACTIVE — en detected → person_b → translate en→es',
      },
      {
        turn: 5, audio: 'turn5.wav',
        speech: 'Qué interesante, ¿cuánto tiempo llevas aquí?',
        detectedLang: 'es', confidence: 0.90,
        expected: { speaker: 'person_a', src: 'es', tgt: 'en' },
        note: 'ACTIVE — back to es → person_a again',
      },
      {
        turn: 6, audio: 'turn6.wav',
        speech: 'About five years now, I love it here.',
        detectedLang: 'en', confidence: 0.89,
        expected: { speaker: 'person_b', src: 'en', tgt: 'es' },
        note: 'ACTIVE — back to en → person_b again',
      },
    ];

    let transcribeCallCount = 0;

    for (const t of conversation) {
      speak(t.speech, t.detectedLang, t.confidence);

      const result = await resolveAutoUtterance(t.audio);

      // ── Speaker routing ─────────────────────────────────────────────────────
      expect(result).not.toBeNull();
      expect(result?.speakerId).toBe(t.expected.speaker);

      // ── Translation direction ───────────────────────────────────────────────
      expect(result?.sourceLang).toBe(t.expected.src);
      expect(result?.targetLang).toBe(t.expected.tgt);

      // ── Transcribed text is passed through (no double-transcription) ────────
      expect(result?.transcribedText).toBe(t.speech);

      // ── STT called ONCE this turn, with audio path but NO language hint ─────
      //
      //   Why no hint? Because in auto mode Whisper auto-detects the language.
      //   In DISCOVERING phases we don't know it yet; in ACTIVE we know it but
      //   re-transcribing with a hint would double latency with minimal gain
      //   for high-confidence detections.
      //
      //   ⚠️  If accuracy suffers in ACTIVE phase, consider re-transcribing
      //       with the identified language hint (trade-off: +latency).
      //
      transcribeCallCount++;
      const args = lastTranscribeArgs();
      expect(args[0]).toBe(t.audio);         // correct audio file
      expect(args[1]).toBeUndefined();        // NO language hint → Whisper auto-detects
      expect((whisperService.transcribe as jest.Mock).mock.calls).toHaveLength(transcribeCallCount);
    }
  });

  /**
   * Edge case: short or ambiguous utterances during discovery.
   * The app should always show something (never go silent),
   * but delay committing langA/langB until confidence is high enough.
   */
  it('handles short phrases gracefully — shows something, delays commitment', async () => {
    // Short "Hola" — confident but too short to commit langA
    speak('Hola', 'es', 0.95);
    const r1 = await resolveAutoUtterance('hola.wav');
    expect(r1).not.toBeNull();              // still shows the turn
    expect(r1?.speakerId).toBe('person_a');

    // Slightly longer but low confidence — routes but doesn't commit
    speak('Sí, claro', 'es', 0.6);
    const r2 = await resolveAutoUtterance('si.wav');
    expect(r2).not.toBeNull();
    expect(r2?.speakerId).toBe('person_a');

    // Now a full confident sentence → commits langA
    speak('Muy buenos días, encantado de conocerte.', 'es', 0.93);
    const r3 = await resolveAutoUtterance('buenos.wav');
    expect(r3).not.toBeNull();
    expect(r3?.speakerId).toBe('person_a');
    // langA now committed → next different-language turn advances to ACTIVE
  });

  /**
   * Edge case: unknown language in ACTIVE phase.
   * A third person speaks French → app ignores it (returns null, shows nothing).
   */
  it('silently ignores a third language in ACTIVE phase', async () => {
    // Advance to ACTIVE: es / en
    speak('Buenos días, ¿cómo estás hoy?', 'es', 0.92);
    await resolveAutoUtterance('a1.wav');
    speak('Good morning everyone how are you doing?', 'en', 0.91);
    await resolveAutoUtterance('b1.wav');

    // Someone speaks French
    speak('Bonjour, comment allez-vous?', 'fr', 0.90);
    const result = await resolveAutoUtterance('fr.wav');

    expect(result).toBeNull(); // correctly ignored — no transcript added to conversation
  });

  /**
   * Edge case: low-confidence detection in ACTIVE phase.
   * Noisy audio or an unclear phrase → app ignores it rather than misrouting.
   */
  it('drops low-confidence utterances in ACTIVE phase to avoid misrouting', async () => {
    speak('Buenos días, ¿cómo estás hoy?', 'es', 0.92);
    await resolveAutoUtterance('a1.wav');
    speak('Good morning everyone how are you doing?', 'en', 0.91);
    await resolveAutoUtterance('b1.wav');

    // Unclear audio — lang detected but confidence too low
    speak('...mumble...', 'es', 0.35);
    const result = await resolveAutoUtterance('noise.wav');

    expect(result).toBeNull(); // better to drop than to misroute
  });
});

describe('Conversation simulation: reversed — English first, then Spanish', () => {
  it('correctly assigns person_a to English when they speak first', async () => {
    // Turn 1: English speaker goes first
    speak('Hello, how are you doing today?', 'en', 0.92);
    const r1 = await resolveAutoUtterance('a1.wav');
    expect(r1?.speakerId).toBe('person_a');
    expect(r1?.sourceLang).toBe('en');
    // langA = 'en' = DEFAULT_LANG_B, so interim target falls back to settingsStore.personB.language ('es')
    expect(r1?.targetLang).toBe('es');

    // Turn 2: Spanish speaker
    speak('Buenos días, un placer conocerte.', 'es', 0.91);
    const r2 = await resolveAutoUtterance('b1.wav');
    expect(r2?.speakerId).toBe('person_b');
    expect(r2?.sourceLang).toBe('es');
    expect(r2?.targetLang).toBe('en');

    // Turn 3: ACTIVE — English person speaks again
    speak('Nice to meet you too!', 'en', 0.88);
    const r3 = await resolveAutoUtterance('a2.wav');
    expect(r3?.speakerId).toBe('person_a');
    expect(r3?.sourceLang).toBe('en');
    expect(r3?.targetLang).toBe('es');
  });
});
