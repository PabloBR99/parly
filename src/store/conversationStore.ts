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

/**
 * Live "breath" of the hands-free seam wave. Mirrors the HF state machine:
 * `capturing → 'listening'`, `speaking → 'speaking'`, everything else → 'idle'.
 * Drives `SeamControl`'s wave; it does NOT imply which speaker is talking.
 */
export type HfActivity = 'idle' | 'listening' | 'speaking';

interface ConversationState {
  readonly turns: readonly Turn[];
  readonly activeTurnId: string | null;
  /** 'ptt' = push-to-talk (default); 'hf' = hands-free continuous mode. */
  readonly mode: 'ptt' | 'hf';
  /** Which speaker is currently the source of an HF turn being routed. */
  readonly hfActiveSpeaker: PersonId | null;
  /** Flashes briefly when an utterance was not routable (lang ∉ pair). */
  readonly hfUnroutedSpeaker: PersonId | null;
  /** What the hands-free control is doing right now — drives the seam wave. */
  readonly hfActivity: HfActivity;
}

interface ConversationActions {
  startTurn: (turn: Turn) => void;
  updateTurn: (id: string, patch: Partial<Turn>) => void;
  endTurn: (id: string, finalPatch?: Partial<Turn>) => void;
  clear: () => void;
  setMode: (mode: 'ptt' | 'hf') => void;
  setHfActiveSpeaker: (id: PersonId | null) => void;
  setHfUnroutedSpeaker: (id: PersonId | null) => void;
  setHfActivity: (activity: HfActivity) => void;
}

export const useConversationStore = create<ConversationState & ConversationActions>(set => ({
  turns: [],
  activeTurnId: null,
  mode: 'ptt',
  hfActiveSpeaker: null,
  hfUnroutedSpeaker: null,
  hfActivity: 'idle',

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

  clear: () => set({ turns: [], activeTurnId: null }),

  setMode: mode => set({ mode }),

  setHfActiveSpeaker: id => set({ hfActiveSpeaker: id }),

  setHfUnroutedSpeaker: id => set({ hfUnroutedSpeaker: id }),

  setHfActivity: activity => set({ hfActivity: activity }),
}));
