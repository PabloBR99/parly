// useAudioLevel — bridges the microphone level bus into a Reanimated shared
// value, so an animation can read live loudness without a single React render.
//
// The bus publishes every 32 ms (one VAD frame). Assigning that straight to a
// shared value would step the wave at ~31 Hz against a 60 Hz screen — visible
// as a faint stutter on every bar. Each published sample is therefore handed
// over as a short *linear* tween: the UI thread walks to the new value across
// roughly one frame period, so the wave is continuous between samples and
// still lands on real data, not on invented motion.
//
// `active` is the honesty switch. The level is only meaningful while the mic
// is open and hearing the room; anywhere else the value eases back to silence
// and the subscription is dropped, so nothing is computed in PTT mode.

import { useEffect } from 'react';
import {
  cancelAnimation,
  Easing,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { FRAME_MS, subscribeAudioLevel } from '../../services/audio/audioLevelBus';

/** Slightly longer than a frame, so consecutive samples always overlap. */
const SAMPLE_TWEEN_MS = Math.round(FRAME_MS * 2.5);
/** How long the meter takes to fall to silence once it goes inactive. */
const SETTLE_MS = 280;

export function useAudioLevel(active: boolean): SharedValue<number> {
  const level = useSharedValue(0);

  useEffect(() => {
    if (!active) {
      cancelAnimation(level);
      level.value = withTiming(0, { duration: SETTLE_MS, easing: Easing.out(Easing.quad) });
      return;
    }
    return subscribeAudioLevel(next => {
      level.value = withTiming(next, {
        duration: SAMPLE_TWEEN_MS,
        easing: Easing.linear,
      });
    });
  }, [active, level]);

  return level;
}
