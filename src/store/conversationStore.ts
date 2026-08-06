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

/**
 * Live partial transcript while a hands-free utterance is still being
 * captured. `side` is the classifier's best guess at who is talking (from
 * the transcript's own language) — null until there is enough text to call
 * it. Cleared the moment the utterance is flushed and routed into a real
 * turn. Without this, a long hands-free monologue shows a dead screen for
 * its entire duration.
 */
export interface HfLivePartial {
  readonly side: PersonId | null;
  readonly text: string;
}

/**
 * Keys for the per-speaker notice pane. The store carries a KEY, not a
 * sentence: each half renders the notice in its reader's language
 * (`i18n/strings.ts`), because the two people at the table do not share one.
 * Raw service errors stay in the log buffer only.
 */
export type NoticeKey =
  | 'connectionDropped'
  | 'keyInvalid'
  | 'rateLimit'
  | 'generic'
  | 'didntCatch'
  | 'micPermission'
  | 'noVoice'
  | 'offline';

export interface SpeakerNotice {
  readonly key: NoticeKey;
  /** 'error' renders in the error tint; 'info' is a quieter guidance tone. */
  readonly kind: 'error' | 'info';
  /** Language code for notices that reference one (noVoice). */
  readonly lang?: string;
}

/** Keep the history bounded: `updateTurn` maps the whole array on every STT
 *  partial (several per second during capture), so an unbounded array turns a
 *  long session into per-frame O(n) work exactly when the frame budget is
 *  tightest. 50 turns is far more scroll-back than either reader uses. */
const MAX_TURNS = 50;

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
  /** Streaming transcript of the hands-free utterance being captured. */
  readonly hfLive: HfLivePartial | null;
  /** Per-speaker notice shown on that speaker's own half, in their language. */
  readonly notices: { readonly [K in PersonId]: SpeakerNotice | null };
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
  setHfLive: (live: HfLivePartial | null) => void;
  setNotice: (speaker: PersonId, notice: SpeakerNotice | null) => void;
}

const emptyNotices = { person_a: null, person_b: null } as const;

export const useConversationStore = create<ConversationState & ConversationActions>(set => ({
  turns: [],
  activeTurnId: null,
  mode: 'ptt',
  hfActiveSpeaker: null,
  hfUnroutedSpeaker: null,
  hfActivity: 'idle',
  hfLive: null,
  notices: emptyNotices,

  startTurn: turn =>
    set(state => ({
      turns:
        state.turns.length >= MAX_TURNS
          ? [...state.turns.slice(state.turns.length - MAX_TURNS + 1), turn]
          : [...state.turns, turn],
      activeTurnId: turn.id,
    })),

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

  clear: () => set({ turns: [], activeTurnId: null, hfLive: null, notices: emptyNotices }),

  setMode: mode => set({ mode }),

  setHfActiveSpeaker: id => set({ hfActiveSpeaker: id }),

  setHfUnroutedSpeaker: id => set({ hfUnroutedSpeaker: id }),

  setHfActivity: activity => set({ hfActivity: activity }),

  setHfLive: hfLive => set({ hfLive }),

  setNotice: (speaker, notice) =>
    set(state => ({ notices: { ...state.notices, [speaker]: notice } })),
}));
