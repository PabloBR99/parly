import { create } from 'zustand';
import type { PersonConfig, PersonId, VoiceId } from '../app/types';

interface SettingsState {
  readonly personA: PersonConfig;
  readonly personB: PersonConfig;
  readonly inputMode: 'ptt' | 'vad';
  readonly autoPlay: boolean;
  readonly ttsNumSteps: number;
}

interface SettingsActions {
  setPersonLanguage: (personId: PersonId, language: string) => void;
  setPersonVoice: (personId: PersonId, voice: VoiceId) => void;
  setPersonDisplayName: (personId: PersonId, name: string) => void;
  setInputMode: (mode: 'ptt' | 'vad') => void;
  setAutoPlay: (autoPlay: boolean) => void;
  setTtsNumSteps: (steps: number) => void;
}

const initialState: SettingsState = {
  personA: { language: 'es', voice: 'casual_male', displayName: 'Persona 1' },
  personB: { language: 'en', voice: 'casual_female', displayName: 'Persona 2' },
  inputMode: 'vad',
  autoPlay: true,
  ttsNumSteps: 5,
};

export const useSettingsStore = create<SettingsState & SettingsActions>(set => ({
  ...initialState,

  setPersonLanguage: (personId, language) =>
    set(state => ({
      [personId === 'person_a' ? 'personA' : 'personB']: {
        ...(personId === 'person_a' ? state.personA : state.personB),
        language,
      },
    })),

  setPersonVoice: (personId, voice) =>
    set(state => ({
      [personId === 'person_a' ? 'personA' : 'personB']: {
        ...(personId === 'person_a' ? state.personA : state.personB),
        voice,
      },
    })),

  setPersonDisplayName: (personId, displayName) =>
    set(state => ({
      [personId === 'person_a' ? 'personA' : 'personB']: {
        ...(personId === 'person_a' ? state.personA : state.personB),
        displayName,
      },
    })),

  setInputMode: mode => set({ inputMode: mode }),

  setAutoPlay: autoPlay => set({ autoPlay }),

  setTtsNumSteps: steps => set({ ttsNumSteps: steps }),
}));
