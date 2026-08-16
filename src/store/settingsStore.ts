import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { DEFAULT_PEOPLE } from '../app/names';

/** Per-speaker config — language is the primary axis; displayName is UI cosmetic. */
export interface PersonConfig {
  readonly language: string;     // BCP-47 short, '' until selected
  readonly displayName: string;
}

/** Mistral chat models available for the translation pipeline. */
export const TRANSLATION_MODELS = [
  { id: 'mistral-small-latest', label: 'Mistral Small  ·  recommended' },
  { id: 'ministral-3b-latest',  label: 'Ministral 3B   ·  faster' },
  { id: 'mistral-large-latest', label: 'Mistral Large  ·  most accurate' },
] as const;

export type TranslationModelId = (typeof TRANSLATION_MODELS)[number]['id'];

/**
 * Whether the stored API key has ever validated against Mistral.
 *  - 'none'        — no key entered.
 *  - 'unvalidated' — key present, no successful check yet (background
 *                    validation is racing; conversation stays enabled).
 *  - 'valid'       — a validation call returned ok.
 *  - 'invalid'     — a validation call returned a definitive auth failure.
 * Only 'valid' earns the green "Connected" treatment; only 'invalid'
 * disables the discs — a merely-unchecked key must not punish offline use.
 */
export type KeyStatus = 'none' | 'unvalidated' | 'valid' | 'invalid';

/**
 * How much right context Voxtral gets before it commits words.
 *  - 'accurate' — 480 ms, where Mistral says the realtime model matches their
 *                 offline one. The default: this app is used across a table by
 *                 people who speak quickly, and a wrong word costs more than
 *                 160 ms.
 *  - 'fast'     — 320 ms. Every reply arrives ~160 ms sooner and ordinary
 *                 sentences still transcribe fine; fast or slurred speech is
 *                 where the difference shows up.
 */
export type TranscriptionMode = 'accurate' | 'fast';

export const TRANSCRIPTION_MODES = [
  { id: 'accurate', label: 'Accurate  ·  recommended' },
  { id: 'fast', label: 'Fast  ·  ~160 ms sooner' },
] as const satisfies ReadonlyArray<{ id: TranscriptionMode; label: string }>;

interface SettingsState {
  readonly personA: PersonConfig;
  readonly personB: PersonConfig;
  readonly mistralApiKey: string;
  readonly keyStatus: KeyStatus;
  readonly translationModel: TranslationModelId;
  readonly transcriptionMode: TranscriptionMode;
  /** The people in this conversation, spelled the way they should appear.
   *  Feeds both the phonetic repair of the transcript and the translator's
   *  glossary — see src/app/names.ts. */
  readonly people: readonly string[];
  readonly languagePairConfigured: boolean;
  /** Whether this user has ever engaged the hands-free control. Until true,
   *  the seam wave carries a labelled hint — an unlabelled 66×28 pill is
   *  invisible to someone who was never told it exists. */
  readonly hfDiscovered: boolean;
}

interface SettingsActions {
  setPersonLanguage: (which: 'A' | 'B', language: string) => void;
  /** User-driven key change: resets keyStatus to unvalidated/none. */
  setMistralApiKey: (key: string) => void;
  /** Startup hydration from the keychain — must NOT touch keyStatus (the
   *  persisted status carries whether this key ever validated). */
  hydrateMistralApiKey: (key: string) => void;
  setKeyStatus: (status: KeyStatus) => void;
  setTranslationModel: (model: TranslationModelId) => void;
  setTranscriptionMode: (mode: TranscriptionMode) => void;
  setPeople: (people: readonly string[]) => void;
  setLanguagePairConfigured: (v: boolean) => void;
  setHfDiscovered: (v: boolean) => void;
}

const initialState: SettingsState = {
  personA: { language: '', displayName: 'You' },
  personB: { language: '', displayName: 'Other' },
  mistralApiKey: '',
  keyStatus: 'none',
  translationModel: 'mistral-small-latest',
  transcriptionMode: 'accurate',
  people: DEFAULT_PEOPLE,
  languagePairConfigured: false,
  hfDiscovered: false,
};

// Persistence adapter over react-native-fs (already a dependency for the log
// store) — no extra native module. The API key itself stays in the keychain
// (secureStorage); everything else is non-secret preference data, and losing
// it on every restart made the app re-interrogate a returning user about
// their languages on every single open.
const rnfsStorage: StateStorage = {
  getItem: async (name) => {
    try {
      const path = `${RNFS.DocumentDirectoryPath}/${name}.json`;
      if (!(await RNFS.exists(path))) return null;
      return await RNFS.readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    try {
      await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/${name}.json`, value, 'utf8');
    } catch {
      // Disk full / permissions — settings simply won't survive the restart.
    }
  },
  removeItem: async (name) => {
    try {
      await RNFS.unlink(`${RNFS.DocumentDirectoryPath}/${name}.json`);
    } catch {
      /* already gone */
    }
  },
};

export const useSettingsStore = create<SettingsState & SettingsActions>()(
  persist(
    set => ({
      ...initialState,

      setPersonLanguage: (which, language) =>
        set(state => ({
          [which === 'A' ? 'personA' : 'personB']: {
            ...(which === 'A' ? state.personA : state.personB),
            language,
          },
        })),

      setMistralApiKey: key =>
        set({ mistralApiKey: key, keyStatus: key.trim() === '' ? 'none' : 'unvalidated' }),

      hydrateMistralApiKey: key => set({ mistralApiKey: key }),

      setKeyStatus: keyStatus => set({ keyStatus }),

      setTranslationModel: translationModel => set({ translationModel }),

      setTranscriptionMode: transcriptionMode => set({ transcriptionMode }),

      setPeople: people => set({ people }),

      setLanguagePairConfigured: languagePairConfigured =>
        set({ languagePairConfigured }),

      setHfDiscovered: hfDiscovered => set({ hfDiscovered }),
    }),
    {
      name: 'parly-settings',
      storage: createJSONStorage(() => rnfsStorage),
      // Everything except the key itself, which lives in the keychain.
      partialize: state => ({
        personA: state.personA,
        personB: state.personB,
        keyStatus: state.keyStatus,
        translationModel: state.translationModel,
        transcriptionMode: state.transcriptionMode,
        people: state.people,
        languagePairConfigured: state.languagePairConfigured,
        hfDiscovered: state.hfDiscovered,
      }),
    },
  ),
);
