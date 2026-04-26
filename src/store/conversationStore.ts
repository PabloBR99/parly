import { create } from 'zustand';
import type { PersonId } from '../app/types';

export type TurnStage =
  | 'recording'      // capturing audio
  | 'transcribing'   // STT in progress, partials arriving
  | 'translating'    // translation streaming
  | 'speaking'       // TTS playing
  | 'done'
  | 'error';

export interface Turn {
  readonly id: string;
  readonly speakerId: PersonId;
  readonly sourceLang: string;
  readonly targetLang: string;
  readonly sourceText: string;       // updated live during STT
  readonly translatedText: string;   // updated live during translation
  readonly stage: TurnStage;
  readonly errorMessage?: string;
  readonly startedAt: number;
}

interface ConversationState {
  readonly turns: readonly Turn[];
  readonly activeTurnId: string | null;
}

interface ConversationActions {
  startTurn: (turn: Turn) => void;
  updateTurn: (id: string, patch: Partial<Turn>) => void;
  endTurn: (id: string, finalPatch?: Partial<Turn>) => void;
  setActiveTurn: (id: string | null) => void;
  clear: () => void;
}

export const useConversationStore = create<ConversationState & ConversationActions>(set => ({
  turns: [],
  activeTurnId: null,

  startTurn: turn =>
    set(state => ({ turns: [...state.turns, turn], activeTurnId: turn.id })),

  updateTurn: (id, patch) =>
    set(state => ({
      turns: state.turns.map(t => (t.id === id ? { ...t, ...patch } : t)),
    })),

  endTurn: (id, finalPatch = {}) =>
    set(state => ({
      turns: state.turns.map(t =>
        t.id === id ? { ...t, ...finalPatch, stage: finalPatch.stage ?? 'done' } : t,
      ),
      activeTurnId: state.activeTurnId === id ? null : state.activeTurnId,
    })),

  setActiveTurn: activeTurnId => set({ activeTurnId }),

  clear: () => set({ turns: [], activeTurnId: null }),
}));
