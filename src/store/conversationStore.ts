import { create } from 'zustand';
import type { Message, PersonId, PipelineStage } from '../app/types';

interface ConversationState {
  readonly messages: readonly Message[];
  readonly activeSpeaker: PersonId | null;
  readonly pipelineStage: PipelineStage;
}

interface ConversationActions {
  addMessage: (message: Message) => void;
  updateMessage: (id: string, patch: Partial<Message>) => void;
  removeMessage: (id: string) => void;
  setActiveSpeaker: (speaker: PersonId | null) => void;
  setPipelineStage: (stage: PipelineStage) => void;
  clearConversation: () => void;
}

const initialState: ConversationState = {
  messages: [],
  activeSpeaker: null,
  pipelineStage: 'idle',
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

  clearConversation: () => set({ messages: [], activeSpeaker: null, pipelineStage: 'idle' }),
}));
