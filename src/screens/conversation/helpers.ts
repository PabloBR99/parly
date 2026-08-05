import { useEffect, useRef } from 'react';
import type { Turn, TurnStage } from '../../store/conversationStore';
import type { PersonId } from '../../app/types';
import { stringsFor } from '../../i18n/strings';
import { haptics } from '../../ui';

export function findLastTurn(turns: readonly Turn[], speakerId: PersonId): Turn | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].speakerId === speakerId) return turns[i];
  }
  return null;
}

/**
 * Stage word for a half, in that half's READER'S language. The two people at
 * the table don't share one — an English "thinking" on the Japanese half is
 * chrome only one side can read.
 */
export function stageMicrocopy(stage: TurnStage | null, readerLang: string): string {
  const t = stringsFor(readerLang);
  switch (stage) {
    case 'recording': return t.listening;
    case 'transcribing':
    case 'translating': return t.thinking;
    case 'speaking': return t.speaking;
    case 'error': return t.error;
    default: return '';
  }
}

/**
 * Wires `haptics` pulse / tick / done / error to the orchestrator's per-turn
 * state machine. The PTT-press tap is fired inside PTTButton itself;
 * everything else flows through here.
 */
export function useTurnHaptics(
  active: Turn | null,
  lastA: Turn | null,
  lastB: Turn | null,
): void {
  const prevActive = useRef<TurnStage | null>(null);
  useEffect(() => {
    const curr = active?.stage ?? null;
    const prev = prevActive.current;
    if (prev !== curr) {
      if (
        (prev === 'recording' && curr === 'transcribing') ||
        (prev === 'transcribing' && curr === 'translating')
      ) {
        haptics.pulse();
      }
      if (prev === 'translating' && curr === 'speaking') {
        haptics.tick();
      }
      prevActive.current = curr;
    }
  }, [active?.stage]);

  useTerminalHaptic(lastA);
  useTerminalHaptic(lastB);
}

function useTerminalHaptic(turn: Turn | null): void {
  const prev = useRef<TurnStage | null>(null);
  const hadText = turn !== null && turn.translatedText.length > 0;
  useEffect(() => {
    const curr = turn?.stage ?? null;
    if (prev.current !== curr) {
      if (prev.current !== null) {
        // The success buzz is a physical claim that a translation happened.
        // Empty turns (discarded audio, blank transcript, user cancel) end as
        // 'done' too — those must stay silent, not confirm a turn that never
        // was.
        if (curr === 'done' && hadText) haptics.done();
        else if (curr === 'error') haptics.error();
      }
      prev.current = curr;
    }
  }, [turn?.stage, hadText]);
}
