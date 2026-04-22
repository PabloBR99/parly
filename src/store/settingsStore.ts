import { create } from 'zustand';
import type { PersonConfig, PersonId, VoiceId } from '../app/types';

/**
 * STT transport preference.
 *   'auto'    — use online (Voxtral) when network is reachable, else offline (Whisper).
 *   'online'  — always try online; fail the utterance if unreachable.
 *   'offline' — always use on-device Whisper, even when online is available.
 */
export type SttTransport = 'auto' | 'online' | 'offline';

interface SettingsState {
  readonly personA: PersonConfig;
  readonly personB: PersonConfig;
  readonly inputMode: 'ptt' | 'vad';
  readonly autoPlay: boolean;
  readonly ttsNumSteps: number;
  /** Wait-k: number of source tokens before starting TTS. 0 = disabled. */
  readonly waitK: number;
  readonly sttTransport: SttTransport;
  /**
   * Mistral API key for online transcription (Voxtral).
   * TODO: migrate to react-native-keychain for secure storage — current in-memory
   * zustand state is fine for dev but leaks through redux devtools / memory dumps.
   */
  readonly mistralApiKey: string;
}

interface SettingsActions {
  setPersonLanguage: (personId: PersonId, language: string) => void;
  setPersonVoice: (personId: PersonId, voice: VoiceId) => void;
  setPersonDisplayName: (personId: PersonId, name: string) => void;
  setInputMode: (mode: 'ptt' | 'vad') => void;
  setAutoPlay: (autoPlay: boolean) => void;
  setTtsNumSteps: (steps: number) => void;
  setWaitK: (k: number) => void;
  setSttTransport: (transport: SttTransport) => void;
  setMistralApiKey: (key: string) => void;
}

const initialState: SettingsState = {
  personA: { language: 'es', voice: 'casual_male', displayName: 'Persona 1' },
  personB: { language: 'en', voice: 'casual_female', displayName: 'Persona 2' },
  inputMode: 'vad',
  autoPlay: true,
  ttsNumSteps: 5,
  waitK: 5,
  sttTransport: 'auto',
  mistralApiKey: '',
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

  setWaitK: k => set({ waitK: k }),

  setSttTransport: transport => set({ sttTransport: transport }),

  setMistralApiKey: key => set({ mistralApiKey: key }),
}));
