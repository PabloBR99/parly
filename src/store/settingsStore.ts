import { create } from 'zustand';

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

interface SettingsState {
  readonly personA: PersonConfig;
  readonly personB: PersonConfig;
  readonly mistralApiKey: string;
  readonly translationModel: TranslationModelId;
  readonly languagePairConfigured: boolean;
}

interface SettingsActions {
  setPersonLanguage: (which: 'A' | 'B', language: string) => void;
  setPersonDisplayName: (which: 'A' | 'B', displayName: string) => void;
  setMistralApiKey: (key: string) => void;
  setTranslationModel: (model: TranslationModelId) => void;
  setLanguagePairConfigured: (v: boolean) => void;
  resetLanguagePair: () => void;
}

const initialState: SettingsState = {
  personA: { language: '', displayName: 'You' },
  personB: { language: '', displayName: 'Other' },
  mistralApiKey: '',
  translationModel: 'mistral-small-latest',
  languagePairConfigured: false,
};

export const useSettingsStore = create<SettingsState & SettingsActions>(set => ({
  ...initialState,

  setPersonLanguage: (which, language) =>
    set(state => ({
      [which === 'A' ? 'personA' : 'personB']: {
        ...(which === 'A' ? state.personA : state.personB),
        language,
      },
    })),

  setPersonDisplayName: (which, displayName) =>
    set(state => ({
      [which === 'A' ? 'personA' : 'personB']: {
        ...(which === 'A' ? state.personA : state.personB),
        displayName,
      },
    })),

  setMistralApiKey: key => set({ mistralApiKey: key }),

  setTranslationModel: translationModel => set({ translationModel }),

  setLanguagePairConfigured: languagePairConfigured =>
    set({ languagePairConfigured }),

  resetLanguagePair: () =>
    set({
      personA: { ...initialState.personA },
      personB: { ...initialState.personB },
      languagePairConfigured: false,
    }),
}));
