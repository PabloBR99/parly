/**
 * Unit tests for the 3-phase language discovery state machine.
 * All native services are mocked — no device, emulator, or build required.
 *
 * Run with:  npx jest src/services/pipeline/__tests__/DiscoveryStateMachine
 */

// ── Mocks (hoisted before imports) ────────────────────────────────────────────

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
}));

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

// Provide getTranslationService as a bare jest.fn(); we configure its return value in beforeAll.
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
  useModelStore: {
    getState: jest.fn().mockReturnValue({ zipvoiceStatus: 'idle' }),
  },
}));

jest.mock('../../../store/settingsStore', () => ({
  useSettingsStore: {
    getState: jest.fn(),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { whisperService } from '../../stt/WhisperService';
import { resolveAutoUtterance, resetDiscovery } from '../PipelineOrchestrator';

// ── Shared mock service ───────────────────────────────────────────────────────

/** Synchronous reference to the mock translation service. */
const mockSvc = {
  identifyLanguage: jest.fn<Promise<{ language: string; confidence: number }[]>, [string]>(),
  translate: jest.fn().mockResolvedValue({ text: 'translated' }),
  downloadLanguagePair: jest.fn().mockResolvedValue(undefined),
};

// ── Test helpers ──────────────────────────────────────────────────────────────

const AUDIO = '/tmp/test.wav';

function mockTranscribe(text: string): void {
  (whisperService.transcribe as jest.Mock).mockResolvedValue({ text });
}

function mockIdentifyLanguage(language: string, confidence: number): void {
  mockSvc.identifyLanguage.mockResolvedValue([{ language, confidence }]);
}

/**
 * Configures useSettingsStore.getState() and returns the new setPersonLanguage spy.
 */
function setupSettings(opts?: {
  personALang?: string;
  personBLang?: string;
  inputMode?: 'vad' | 'ptt';
}): { setPersonLanguage: jest.Mock } {
  const { useSettingsStore } = jest.requireMock('../../../store/settingsStore');
  const setPersonLanguage = jest.fn();
  useSettingsStore.getState.mockReturnValue({
    personA: { language: opts?.personALang ?? 'es', voice: 'casual_male', displayName: 'A' },
    personB: { language: opts?.personBLang ?? 'en', voice: 'casual_female', displayName: 'B' },
    inputMode: opts?.inputMode ?? 'vad',
    autoPlay: false,
    ttsNumSteps: 5,
    setPersonLanguage,
  });
  return { setPersonLanguage };
}

/** Advance to DISCOVERING_B: commits langA = 'es'. */
async function goToDiscoveringB(): Promise<void> {
  mockTranscribe('Buenos días, ¿cómo estás hoy?'); // 26 chars ≥ 15
  mockIdentifyLanguage('es', 0.92);
  await resolveAutoUtterance(AUDIO);
}

/** Advance to ACTIVE: commits langA = 'es', langB = 'en'. */
async function goToActive(): Promise<void> {
  await goToDiscoveringB();
  mockTranscribe('Good morning everyone, how are you?'); // 35 chars ≥ 15
  mockIdentifyLanguage('en', 0.92);
  await resolveAutoUtterance(AUDIO);
}

// ── Suite setup ───────────────────────────────────────────────────────────────

beforeAll(() => {
  // Wire the singleton mock to return our shared mockSvc.
  const { getTranslationService } = jest.requireMock(
    '../../translation/TranslationServiceSingleton',
  );
  getTranslationService.mockResolvedValue(mockSvc);
});

beforeEach(() => {
  resetDiscovery();
  jest.clearAllMocks();
  // Re-wire after clearAllMocks (clearAllMocks clears call history only, not implementations,
  // but mockReturnValue is an implementation — so we must re-apply it).
  const { getTranslationService } = jest.requireMock(
    '../../translation/TranslationServiceSingleton',
  );
  getTranslationService.mockResolvedValue(mockSvc);
  mockSvc.downloadLanguagePair.mockResolvedValue(undefined);
  mockSvc.translate.mockResolvedValue({ text: 'translated' });
  setupSettings();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryStateMachine', () => {
  // ── Phase 1: DISCOVERING_A ─────────────────────────────────────────────────
  describe('DISCOVERING_A', () => {
    it('always routes as person_a even with low confidence', async () => {
      mockTranscribe('Hello there');
      mockIdentifyLanguage('en', 0.5); // below DISCOVERY_CONFIDENCE (0.85)

      const r = await resolveAutoUtterance(AUDIO);

      expect(r).not.toBeNull();
      expect(r?.speakerId).toBe('person_a');
      expect(r?.transcribedText).toBe('Hello there');
    });

    it('does NOT commit langA when confidence < 0.85', async () => {
      const { setPersonLanguage } = setupSettings();
      mockTranscribe('Hello world testing long sentence');
      mockIdentifyLanguage('en', 0.7);

      await resolveAutoUtterance(AUDIO);

      expect(setPersonLanguage).not.toHaveBeenCalled();
    });

    it('does NOT commit langA when text is too short (< 15 chars)', async () => {
      const { setPersonLanguage } = setupSettings();
      mockTranscribe('Hola mundo'); // 10 chars < 15
      mockIdentifyLanguage('es', 0.95);

      await resolveAutoUtterance(AUDIO);

      expect(setPersonLanguage).not.toHaveBeenCalled();
    });

    it('commits langA and calls setPersonLanguage when high conf + long text', async () => {
      const { setPersonLanguage } = setupSettings();
      mockTranscribe('Buenos días, ¿cómo estás hoy?'); // ≥ 15 chars
      mockIdentifyLanguage('es', 0.92); // ≥ 0.85

      const r = await resolveAutoUtterance(AUDIO);

      expect(r?.speakerId).toBe('person_a');
      expect(setPersonLanguage).toHaveBeenCalledWith('person_a', 'es');
    });

    it('uses DEFAULT_LANG_B (en) as targetLang when langA is not en', async () => {
      mockTranscribe('Buenos días, ¿cómo estás hoy?');
      mockIdentifyLanguage('es', 0.92);

      const r = await resolveAutoUtterance(AUDIO);

      expect(r?.targetLang).toBe('en');
    });

    it('falls back to personB.language when langA equals DEFAULT_LANG_B', async () => {
      // langA = 'en' → translating en→en is a no-op; use personB.language instead
      setupSettings({ personALang: 'es', personBLang: 'fr' });
      mockTranscribe('Hello this is a long enough sentence');
      mockIdentifyLanguage('en', 0.92);

      const r = await resolveAutoUtterance(AUDIO);

      expect(r?.targetLang).toBe('fr');
    });

    it('returns null for whisper noise tags', async () => {
      mockTranscribe('[BLANK_AUDIO]');
      mockIdentifyLanguage('en', 0.9);

      const r = await resolveAutoUtterance(AUDIO);

      expect(r).toBeNull();
    });

    it('returns null for empty transcription', async () => {
      mockTranscribe('   ');
      mockIdentifyLanguage('en', 0.9);

      const r = await resolveAutoUtterance(AUDIO);

      expect(r).toBeNull();
    });
  });

  // ── Phase 2: DISCOVERING_B ─────────────────────────────────────────────────
  describe('DISCOVERING_B', () => {
    beforeEach(async () => {
      // Advance to DISCOVERING_B: langA = 'es'
      await goToDiscoveringB();
    });

    it('routes as person_a when same language as A is detected', async () => {
      mockTranscribe('Muy buenos días a todos');
      mockIdentifyLanguage('es', 0.88);

      const r = await resolveAutoUtterance(AUDIO);

      expect(r?.speakerId).toBe('person_a');
      expect(r?.sourceLang).toBe('es');
    });

    it('routes tentatively as person_b when different lang with medium conf (≥ 0.5)', async () => {
      mockTranscribe('Good morning how are you');
      mockIdentifyLanguage('en', 0.65);

      const r = await resolveAutoUtterance(AUDIO);

      expect(r?.speakerId).toBe('person_b');
      expect(r?.sourceLang).toBe('en');
      expect(r?.targetLang).toBe('es');
    });

    it('routes as person_a when different lang but confidence < 0.5', async () => {
      mockTranscribe('Something ambiguous blah');
      mockIdentifyLanguage('fr', 0.3); // below ACTIVE_CONFIDENCE (0.5)

      const r = await resolveAutoUtterance(AUDIO);

      expect(r?.speakerId).toBe('person_a');
    });

    it('commits langB and advances to ACTIVE when different lang + high conf + long text', async () => {
      const { setPersonLanguage } = setupSettings();
      mockTranscribe('Good morning everyone, how are you?'); // ≥ 15 chars
      mockIdentifyLanguage('en', 0.92); // different from 'es', ≥ 0.85

      const r = await resolveAutoUtterance(AUDIO);

      expect(r?.speakerId).toBe('person_b');
      expect(r?.sourceLang).toBe('en');
      expect(r?.targetLang).toBe('es');
      expect(setPersonLanguage).toHaveBeenCalledWith('person_b', 'en');
    });

    it('does NOT commit langB when text is too short (< 15 chars)', async () => {
      const { setPersonLanguage } = setupSettings();
      mockTranscribe('Hello'); // 5 chars < 15
      mockIdentifyLanguage('en', 0.95);

      await resolveAutoUtterance(AUDIO);

      expect(setPersonLanguage).not.toHaveBeenCalled();
    });

    it('does NOT commit langB when confidence < 0.85 (even with long text)', async () => {
      const { setPersonLanguage } = setupSettings();
      mockTranscribe('Good morning everyone how are you');
      mockIdentifyLanguage('en', 0.7); // below DISCOVERY_CONFIDENCE

      await resolveAutoUtterance(AUDIO);

      expect(setPersonLanguage).not.toHaveBeenCalled();
    });
  });

  // ── Phase 3: ACTIVE ────────────────────────────────────────────────────────
  describe('ACTIVE', () => {
    beforeEach(async () => {
      setupSettings({ personALang: 'es', personBLang: 'en' });
      await goToActive(); // langA='es', langB='en'
      // Re-apply settings so tests start with a clean spy
      setupSettings({ personALang: 'es', personBLang: 'en' });
    });

    it('routes as person_a when langA is detected', async () => {
      mockTranscribe('Buenos días, ¿cómo estás?');
      mockIdentifyLanguage('es', 0.85);

      const r = await resolveAutoUtterance(AUDIO);

      expect(r?.speakerId).toBe('person_a');
      expect(r?.sourceLang).toBe('es');
      expect(r?.targetLang).toBe('en');
    });

    it('routes as person_b when langB is detected', async () => {
      mockTranscribe('Good morning, how are you today?');
      mockIdentifyLanguage('en', 0.85);

      const r = await resolveAutoUtterance(AUDIO);

      expect(r?.speakerId).toBe('person_b');
      expect(r?.sourceLang).toBe('en');
      expect(r?.targetLang).toBe('es');
    });

    it('ignores unknown language (returns null)', async () => {
      mockTranscribe('Bonjour, comment vas-tu?');
      mockIdentifyLanguage('fr', 0.9); // 'fr' ≠ 'es' and 'fr' ≠ 'en'

      const r = await resolveAutoUtterance(AUDIO);

      expect(r).toBeNull();
    });

    it('ignores low-confidence detection (returns null)', async () => {
      mockTranscribe('Buenos días');
      mockIdentifyLanguage('es', 0.3); // below ACTIVE_CONFIDENCE (0.5)

      const r = await resolveAutoUtterance(AUDIO);

      expect(r).toBeNull();
    });

    it('uses settingsStore so manual Settings overrides take effect immediately', async () => {
      // User changes langB from 'en' to 'fr' in Settings
      setupSettings({ personALang: 'es', personBLang: 'fr' });
      mockTranscribe('Bonjour, comment allez-vous?');
      mockIdentifyLanguage('fr', 0.88);

      const r = await resolveAutoUtterance(AUDIO);

      expect(r?.speakerId).toBe('person_b');
      expect(r?.sourceLang).toBe('fr');
      expect(r?.targetLang).toBe('es');
    });
  });

  // ── Race condition protection ───────────────────────────────────────────────
  describe('Race condition: resetDiscovery() during async operation', () => {
    it('returns null if reset happens during transcription', async () => {
      (whisperService.transcribe as jest.Mock).mockImplementation(async () => {
        resetDiscovery(); // UI reset fires while transcribe is in-flight
        return { text: 'Buenos días, ¿cómo estás hoy?' };
      });

      const r = await resolveAutoUtterance(AUDIO);

      expect(r).toBeNull();
    });

    it('returns null if reset happens during identifyLanguage', async () => {
      mockTranscribe('Buenos días, ¿cómo estás hoy?');
      mockSvc.identifyLanguage.mockImplementation(async () => {
        resetDiscovery(); // UI reset fires while ML Kit is running
        return [{ language: 'es', confidence: 0.92 }];
      });

      const r = await resolveAutoUtterance(AUDIO);

      expect(r).toBeNull();
    });
  });

  // ── resetDiscovery ──────────────────────────────────────────────────────────
  describe('resetDiscovery', () => {
    it('resets from ACTIVE back to DISCOVERING_A (routes everything, ignores nothing)', async () => {
      setupSettings({ personALang: 'es', personBLang: 'en' });
      await goToActive();

      resetDiscovery();

      // Back in DISCOVERING_A: even ambiguous/low-conf speech is always routed
      mockTranscribe('Something unknown blah');
      mockIdentifyLanguage('zh', 0.4);
      const r = await resolveAutoUtterance(AUDIO);

      expect(r?.speakerId).toBe('person_a'); // never null in DISCOVERING_A
    });

    it('resets from DISCOVERING_B back to DISCOVERING_A', async () => {
      await goToDiscoveringB();

      resetDiscovery();

      mockTranscribe('Hé bien alors');
      mockIdentifyLanguage('fr', 0.4);
      const r = await resolveAutoUtterance(AUDIO);

      expect(r?.speakerId).toBe('person_a');
    });
  });
});
