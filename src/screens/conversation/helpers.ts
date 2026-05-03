import { useEffect, useRef } from 'react';
import type { Turn, TurnStage } from '../../store/conversationStore';
import type { PersonId } from '../../app/types';
import { haptics } from '../../ui';

export function findLastTurn(turns: readonly Turn[], speakerId: PersonId): Turn | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].speakerId === speakerId) return turns[i];
  }
  return null;
}

export function stageMicrocopy(stage: TurnStage | null): string {
  switch (stage) {
    case 'recording': return 'listening';
    case 'transcribing':
    case 'translating': return 'thinking';
    case 'speaking': return 'speaking';
    case 'error': return 'error';
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
  useEffect(() => {
    const curr = turn?.stage ?? null;
    if (prev.current !== curr) {
      if (prev.current !== null) {
        if (curr === 'done') haptics.done();
        else if (curr === 'error') haptics.error();
      }
      prev.current = curr;
    }
  }, [turn?.stage]);
}
