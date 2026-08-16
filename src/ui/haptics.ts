// Tiny haptics wrapper — uses the built-in RN Vibration API on Android.
//
// We don't pull react-native-haptic-feedback (an extra native dep) because
// the audience is Android-only and Vibration patterns are sufficient for
// the texture we want: a tap on press, a softer pulse on state-change,
// a "tick" when assigning a language.
//
// All calls are fire-and-forget: never block UI on haptics, and never
// throw — if the firmware refuses (some vendor ROMs do, even with the
// VIBRATE permission declared) we silently no-op so we don't crash a
// user gesture flow.

import { Vibration } from 'react-native';
import { log } from '../services/log/logStore';
import { errorMessage } from '../app/errors';

function safe(label: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    // Vibration unavailable — ignore but log.
    log.warn(`[haptics] ${label} threw`, errorMessage(e));
  }
}

export const haptics = {
  /** Single short tap — used on PTT press, button taps. */
  tap: () => safe('tap', () => Vibration.vibrate(8)),

  /** Two-step soft pulse — used on state morph (recording → translating). */
  pulse: () => safe('pulse', () => Vibration.vibrate([0, 6, 40, 6])),

  /** Confirmation tick — used when a language is assigned, settings saved. */
  tick: () => safe('tick', () => Vibration.vibrate(12)),

  /** Heavier "done" — turn complete, ready for next handoff. */
  done: () => safe('done', () => Vibration.vibrate([0, 18, 60, 8])),

  /** Error notification. */
  error: () => safe('error', () => Vibration.vibrate([0, 30, 80, 30, 80, 30])),
};
