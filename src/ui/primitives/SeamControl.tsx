// SeamControl — the hands-free toggle, as a horizontal "voice wave" seated
// dead-centre on the seam.
//
// Why here, why neutral?
//   Hands-free is not a property of either speaker — it's a property of the
//   conversation. So it belongs on the seam (the encounter line), not in one
//   speaker's footer. It's neutral white for the same reason the seam is:
//   colour lives in the atmosphere, never in the chrome.
//
// Why a wave, and no text?
//   The shape tells you the state. Off (reposo): a flat, dim equaliser that
//   breathes a faint invite halo — "tappable". On + capturing (escuchando):
//   a lively, uneven wave with a soft inner glow — "your voice is going in".
//   On + TTS (traduciendo): a calm, synchronised swell — "the voice is going
//   out". Offline (paused): dimmed and still. No caption — the wave is the
//   word.
//
// Implementation note: each bar is an Animated.View whose `scaleY` is driven
// by a shared value (rock-solid on Android — far smoother than animating
// height). The pill's background + border cross-fade via interpolateColor.

import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { motion } from '../theme';
import { haptics } from '../haptics';

export type SeamControlMode = 'off' | 'on' | 'paused';
export type SeamActivity = 'idle' | 'listening' | 'speaking';

interface SeamControlProps {
  readonly mode: SeamControlMode;
  /** Splits the "on" look into a lively (listening) vs calm (speaking) wave. */
  readonly activity?: SeamActivity;
  readonly onToggle: () => void;
}

// ── Resolved visual state ────────────────────────────────────────────────────
type Resolved = 'reposo' | 'escuchando' | 'traduciendo' | 'paused';

function resolve(mode: SeamControlMode, activity: SeamActivity): Resolved {
  if (mode === 'off') return 'reposo';
  if (mode === 'paused') return 'paused';
  return activity === 'speaking' ? 'traduciendo' : 'escuchando';
}

// ── Geometry ───────────────────────────────────────────────────────────────
const PILL_W = 66;
const PILL_H = 28;
const BAR_COUNT = 7;

// Per-bar motion (lifted verbatim from the design handoff).
// escuchando — organic, uneven; each bar its own tempo + phase.
const WAVE_PERIODS = [820, 950, 720, 1000, 780, 900, 850]; // ms (full cycle)
const WAVE_DELAYS = [0, 100, 200, 40, 260, 140, 320];       // ms
// traduciendo — a gentle, synchronised swell; one tempo, staggered phase.
const CALM_PERIOD = 1500;                                   // ms (full cycle)
const CALM_DELAYS = [0, 80, 160, 240, 320, 400, 480];       // ms

// Bar geometry per resolved state.
const BAR_HEIGHT: Record<Resolved, number> = {
  reposo: 4,
  escuchando: 16,
  traduciendo: 13,
  paused: 4,
};
const BAR_COLOR: Record<Resolved, string> = {
  reposo: 'rgba(255,255,255,0.40)',
  escuchando: 'rgba(255,255,255,0.95)',
  traduciendo: 'rgba(255,255,255,0.92)',
  paused: 'rgba(255,255,255,0.28)',
};

// ── Bar ──────────────────────────────────────────────────────────────────────
interface BarProps {
  readonly height: number;
  readonly color: string;
  /** Full cycle in ms; 0 = no animation (rest at full height). */
  readonly period: number;
  readonly delay: number;
  /** Resting scaleY at the bottom of the cycle (0.28 wave, 0.5 calm). */
  readonly low: number;
}

function Bar({ height, color, period, delay, low }: BarProps): React.JSX.Element {
  const v = useSharedValue(1);

  useEffect(() => {
    cancelAnimation(v);
    if (period > 0) {
      const half = period / 2;
      // NOTE: do NOT use withDelay here. `withDelay(d, withRepeat(...))`
      // freezes the value at `low` on this Reanimated 4 + worklets release
      // build (the inner repeat never ticks). Instead, stagger the entrance
      // with a leading withTiming, then oscillate with a self-contained
      // withSequence repeat — the same withDelay-free shape proven in
      // Waveform.tsx. This also removes any dependency on a separately-set
      // start value (the old `v.value = low` double-assignment was fragile).
      v.value = withSequence(
        // Match the prototype's CSS entrance: snap to the 0% keyframe (low)
        // and hold there during the per-bar animation-delay, then oscillate.
        withTiming(low, { duration: 0 }),
        withTiming(low, { duration: delay }),
        withRepeat(
          withSequence(
            withTiming(1, { duration: half, easing: Easing.inOut(Easing.sin) }),
            withTiming(low, { duration: half, easing: Easing.inOut(Easing.sin) }),
          ),
          -1,
          false,
        ),
      );
    } else {
      v.value = withTiming(1, { duration: 220, easing: Easing.out(Easing.quad) });
    }
    return () => cancelAnimation(v);
  }, [period, delay, low, v]);

  const style = useAnimatedStyle(() => ({ transform: [{ scaleY: v.value }] }));

  return (
    <Animated.View style={[styles.bar, { height, backgroundColor: color }, style]} />
  );
}

// ── Component ────────────────────────────────────────────────────────────────
export function SeamControl({ mode, activity = 'idle', onToggle }: SeamControlProps): React.JSX.Element {
  const resolved = resolve(mode, activity);
  const isOff = resolved === 'reposo';
  const isPaused = resolved === 'paused';
  const isOn = resolved === 'escuchando' || resolved === 'traduciendo';

  const enter = useSharedValue(0);
  const press = useSharedValue(0);
  const pop = useSharedValue(1);
  const invite = useSharedValue(0);   // breathing halo (off only)
  const glow = useSharedValue(0);     // inner glow (on only)
  // Pill tone: -1 paused, 0 off, 1 on. Drives bg + border cross-fade.
  const tone = useSharedValue(0);

  // Mount entrance.
  useEffect(() => {
    enter.value = withTiming(1, { duration: 420, easing: Easing.out(Easing.cubic) });
  }, [enter]);

  // Pill tone — cross-fade bg + border over ~400 ms.
  useEffect(() => {
    tone.value = withTiming(isPaused ? -1 : isOn ? 1 : 0, {
      duration: 400,
      easing: Easing.inOut(Easing.ease),
    });
  }, [isPaused, isOn, tone]);

  // Engage inhale when hands-free turns on.
  const wasOnRef = React.useRef(false);
  useEffect(() => {
    if (isOn && !wasOnRef.current) {
      pop.value = withSequence(
        withTiming(1.07, { duration: 220, easing: Easing.out(Easing.ease) }),
        withSpring(1, motion.springSoft),
      );
    }
    wasOnRef.current = isOn;
  }, [isOn, pop]);

  // Invite halo — breathes only when off (signals "tappable").
  useEffect(() => {
    if (isOff) {
      invite.value = withRepeat(
        withSequence(
          withTiming(0.66, { duration: 1500, easing: Easing.inOut(Easing.sin) }),
          withTiming(0.16, { duration: 1500, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(invite);
      invite.value = withTiming(0, { duration: motion.fast });
    }
    return () => cancelAnimation(invite);
  }, [isOff, invite]);

  // Active inner glow — breathes only while on.
  useEffect(() => {
    if (isOn) {
      glow.value = withRepeat(
        withSequence(
          withTiming(0.8, { duration: 1000, easing: Easing.inOut(Easing.sin) }),
          withTiming(0.35, { duration: 1000, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(glow);
      glow.value = withTiming(0, { duration: motion.fast });
    }
    return () => cancelAnimation(glow);
  }, [isOn, glow]);

  const handlePress = () => {
    haptics.tap();
    onToggle();
  };

  // ── Animated styles ──────────────────────────────────────────────────────
  const wrapStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [
      { translateX: -PILL_W / 2 },
      { translateY: -PILL_H / 2 },
      { scale: (0.86 + 0.14 * enter.value) * pop.value * (1 - 0.06 * press.value) },
    ],
  }));
  const pillStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      tone.value,
      [-1, 0, 1],
      ['rgba(255,255,255,0.045)', 'rgba(255,255,255,0.045)', 'rgba(255,255,255,0.085)'],
    ),
    borderColor: interpolateColor(
      tone.value,
      [-1, 0, 1],
      ['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.14)', 'rgba(255,255,255,0.32)'],
    ),
  }));
  const inviteStyle = useAnimatedStyle(() => ({ opacity: invite.value }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));

  // Per-bar params for the resolved state.
  const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
    if (resolved === 'escuchando') {
      return { period: WAVE_PERIODS[i], delay: WAVE_DELAYS[i], low: 0.28 };
    }
    if (resolved === 'traduciendo') {
      return { period: CALM_PERIOD, delay: CALM_DELAYS[i], low: 0.5 };
    }
    return { period: 0, delay: 0, low: 1 }; // reposo / paused — flat, still
  });

  const a11yState = isOn ? 'on' : isPaused ? 'paused, offline' : 'off';

  return (
    <Animated.View style={[styles.anchor, wrapStyle]} pointerEvents="box-none">
      <Pressable
        onPress={handlePress}
        onPressIn={() => { press.value = withSpring(1, motion.springSnappy); }}
        onPressOut={() => { press.value = withSpring(0, motion.springSnappy); }}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityState={{ selected: isOn }}
        accessibilityLabel={`Hands-free, ${a11yState}`}
        style={styles.press}>
        {/* Invite halo — a 1 px ring 4 px outside the pill, breathing when off. */}
        <Animated.View style={[styles.invite, inviteStyle]} pointerEvents="none" />

        {/* The pill. The recessed-glass feel is a real inset box-shadow
            (inset 0 1px 2px rgba(0,0,0,.45)) declared in styles.pill, matching
            the prototype exactly. */}
        <Animated.View style={[styles.pill, pillStyle]}>
          {/* Active inner glow (on only). */}
          <Animated.View style={[StyleSheet.absoluteFill, styles.glow, glowStyle]} pointerEvents="none">
            <Svg width={PILL_W} height={PILL_H}>
              <Defs>
                <RadialGradient id="voz-glow" cx="50%" cy="50%" rx="50%" ry="50%" fx="50%" fy="50%">
                  <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.14" />
                  <Stop offset="0.7" stopColor="#FFFFFF" stopOpacity="0" />
                </RadialGradient>
              </Defs>
              <Rect width={PILL_W} height={PILL_H} fill="url(#voz-glow)" />
            </Svg>
          </Animated.View>

          {/* The wave. */}
          <View style={styles.barRow}>
            {bars.map((b, i) => (
              <Bar
                key={i}
                height={BAR_HEIGHT[resolved]}
                color={BAR_COLOR[resolved]}
                period={b.period}
                delay={b.delay}
                low={b.low}
              />
            ))}
          </View>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    left: '50%',
    top: '50%',
  },
  press: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  invite: {
    position: 'absolute',
    top: -4,
    left: -4,
    right: -4,
    bottom: -4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  pill: {
    width: PILL_W,
    height: PILL_H,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    // No overflow:'hidden' — it can suppress inset box-shadows on Android, and
    // nothing here needs clipping (the glow ellipse is already transparent
    // before the corners; the bars are small and centred).
    // Prototype: box-shadow: inset 0 1px 2px rgba(0,0,0,.45). RN 0.84 (New
    // Architecture) supports inset box-shadows natively.
    boxShadow: [
      { inset: true, offsetX: 0, offsetY: 1, blurRadius: 2, spreadDistance: 0, color: 'rgba(0,0,0,0.45)' },
    ],
  },
  glow: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    // Prototype: 7 bars, 2px wide, 3px gap. Use real gap (no outer margins) so
    // the row width matches the prototype exactly.
    gap: 3,
  },
  bar: {
    width: 2,
    borderRadius: 2,
  },
});
