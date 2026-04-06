import { create } from 'zustand';
import type { Message, PersonId, PipelineStage } from '../app/types';

interface LanguageDetection {
  readonly lang: string;
  readonly timestamp: number;
}

export interface StreamingPartial {
  readonly speakerId: PersonId;
  readonly transcript: string;
  readonly translation: string;
  readonly stableTranslation: string;
}

interface ConversationState {
  readonly messages: readonly Message[];
  readonly activeSpeaker: PersonId | null;
  readonly pipelineStage: PipelineStage;
  readonly streamingPartial: StreamingPartial | null;
  readonly detectedLangs: {
    readonly person_a: LanguageDetection | null;
    readonly person_b: LanguageDetection | null;
  };
}

interface ConversationActions {
  addMessage: (message: Message) => void;
  updateMessage: (id: string, patch: Partial<Message>) => void;
  removeMessage: (id: string) => void;
  setActiveSpeaker: (speaker: PersonId | null) => void;
  setPipelineStage: (stage: PipelineStage) => void;
  setStreamingPartial: (partial: StreamingPartial | null) => void;
  setDetectedLang: (personId: PersonId, lang: string) => void;
  clearConversation: () => void;
}

const initialState: ConversationState = {
  messages: [],
  activeSpeaker: null,
  pipelineStage: 'idle',
  streamingPartial: null,
  detectedLangs: { person_a: null, person_b: null },
};

export const useConversationStore = create<ConversationState & ConversationActions>(set => ({
  ...initialState,

  addMessage: message =>
    set(state => ({ messages: [...state.messages, message] })),

  updateMessage: (id, patch) =>
    set(state => ({
      messages: state.messages.map(m => (m.id === id ? { ...m, ...patch } : m)),
    })),

  removeMessage: id =>
    set(state => ({ messages: state.messages.filter(m => m.id !== id) })),

  setActiveSpeaker: speaker => set({ activeSpeaker: speaker }),

  setPipelineStage: stage => set({ pipelineStage: stage }),

  setStreamingPartial: partial => set({ streamingPartial: partial }),

  setDetectedLang: (personId, lang) =>
    set(state => ({
      detectedLangs: {
        ...state.detectedLangs,
        [personId]: { lang, timestamp: Date.now() },
      },
    })),

  clearConversation: () => set({
    messages: [],
    activeSpeaker: null,
    pipelineStage: 'idle',
    streamingPartial: null,
    detectedLangs: { person_a: null, person_b: null },
  }),
}));
