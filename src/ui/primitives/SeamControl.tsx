// SeamControl — the hands-free toggle, as a horizontal "voice wave" seated
// dead-centre on the seam.
//
// It lives on the seam, neutral white, because hands-free is a property of the
// conversation and not of either speaker — colour lives in the atmosphere,
// never in the chrome.
//
// The shape is the caption. Off (reposo): a flat, dim equaliser breathing a
// faint invite halo, "tappable". Listening (escuchando): a wave driven by the
// actual microphone, "the room is going in". Speaking (traduciendo): a calm
// synchronised swell, "the voice is going out". Offline: dimmed and still.
//
// The listening wave is real because a canned loop is a lie the user can catch
// — speak and nothing changes, stay silent and it keeps dancing — leaving the
// one question hands-free must answer at a glance ("is it hearing me?")
// unanswered. `escuchando` reads the live level off audioLevelBus, fed by the
// very frames the VAD takes turns on: the bars ARE the detector's input, drawn.
// `traduciendo` stays synthetic, since the OS exposes no output level and
// mirroring the mic there would visualise the phone's own voice — the echo the
// half-duplex gate exists to prevent.
//
// Bars ripple outward from the centre, arching toward the middle like a
// waveform envelope: this control sits on the line between two people, and
// energy leaves it in both directions at once.
//
// Each bar is an Animated.View driven by `scaleY` (far smoother on Android than
// animating height). The live wave is computed on the UI thread from a phase
// clock and the mic level, so a whole utterance costs zero React renders.

import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
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
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { motion } from '../theme';
import { haptics } from '../haptics';
import { useAudioLevel } from '../animations/useAudioLevel';

export type SeamControlMode = 'off' | 'on' | 'paused';
export type SeamActivity = 'idle' | 'listening' | 'speaking';

interface SeamControlProps {
  readonly mode: SeamControlMode;
  /** Splits the "on" look into a lively (listening) vs calm (speaking) wave. */
  readonly activity?: SeamActivity;
  /**
   * Discoverability hints — the control's name, one label per reader, shown
   * only while off and only until the user first engages hands-free. The
   * wave alone is beautiful but mute: a first-time user has no reason to
   * tap an unlabelled 66×28 pill. `hintTop` renders above the pill rotated
   * 180° (the partner's reading direction); `hintBottom` below, upright.
   * Both breathe in step with the invite halo.
   */
  readonly hintTop?: string | null;
  readonly hintBottom?: string | null;
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
export const BAR_COUNT = 7;

// ── Wave motion ──────────────────────────────────────────────────────────────
// Both live states share one free-running phase clock and one formula; they
// differ only in the constants below. A single clock is what lets the wave
// cross from listening to speaking without a seam.
const TAU = Math.PI * 2;
const CENTRE = (BAR_COUNT - 1) / 2;
/** ms for the ripple to travel one full cycle, per state. */
const RIPPLE_PERIOD = {
  escuchando: 1150,
  traduciendo: 1500,
} satisfies Record<'escuchando' | 'traduciendo', number>;
/** Tiny per-bar phase offsets so the two sides aren't a perfect mirror —
 *  symmetry reads as machinery, a hair of drift reads as breath. */
const DETUNE = [0, 0.16, -0.11, 0, 0.13, -0.15, 0.07];

export interface WaveMotion {
  /** Height held with no signal at all, as a fraction of the bar. */
  readonly floor: number;
  /** How much of the ripple shows through at rest. */
  readonly swing: number;
  /** 0 = ignore the mic entirely, 1 = fully level-driven. */
  readonly reactivity: number;
  /** Radians of ripple per bar out from the centre — bigger = tighter wave. */
  readonly spread: number;
}

export const WAVE_MOTION = {
  // Listening: a silent room still gets a slow, visible roll — clearly taller
  // and brighter than the flat 4 px of `reposo`, so "armed" reads from across
  // the table. The mic owns everything above that, which is roughly two thirds
  // of the bar: quiet speech is unmistakable, a shout fills it.
  escuchando: { floor: 0.28, swing: 0.16, reactivity: 1, spread: 1.05 },
  // Speaking: a slow, near-synchronised swell with no mic input at all.
  traduciendo: { floor: 0.5, swing: 0.5, reactivity: 0, spread: 0.62 },
} satisfies Record<'escuchando' | 'traduciendo', WaveMotion>;

// Bar geometry per resolved state.
const BAR_HEIGHT = {
  reposo: 5,
  escuchando: 16,
  traduciendo: 13,
  paused: 5,
} satisfies Record<Resolved, number>;
const BAR_COLOR = {
  // Off is quiet, but it must still be *there* — an empty pill reads as a bug,
  // not as a resting control. These two are the only thing drawn when nothing
  // is happening, so they carry the whole "this is a thing you can press".
  reposo: 'rgba(255,255,255,0.52)',
  escuchando: 'rgba(255,255,255,0.95)',
  traduciendo: 'rgba(255,255,255,0.92)',
  paused: 'rgba(255,255,255,0.34)',
} satisfies Record<Resolved, string>;

// ── Bars ─────────────────────────────────────────────────────────────────────

/**
 * The off / offline bar: a still dot, always drawn.
 *
 * Deliberately a plain View with no animation and no shared value. An earlier
 * pass had it scale up from 0 on mount, which meant a single missed animation
 * left `scaleY: 0` — seven invisible bars and an empty pill. Nothing about a
 * resting dot needs to animate, so nothing here can fail to.
 */
function StillBar({ height, color }: { height: number; color: string }): React.JSX.Element {
  return <View style={[styles.bar, { height, backgroundColor: color }]} />;
}

interface WaveBarProps {
  readonly index: number;
  readonly height: number;
  readonly color: string;
  /** Free-running 0→1 sawtooth shared by every bar. */
  readonly phase: SharedValue<number>;
  /** Smoothed mic level, 0..1. Ignored when `reactivity` is 0. */
  readonly level: SharedValue<number>;
  readonly floor: number;
  readonly swing: number;
  readonly reactivity: number;
  readonly spread: number;
}

/**
 * The whole wave, as one expression: bar `index`'s height as a fraction of the
 * bar, given the clock and the mic.
 *
 * Runs on the UI thread (it is a worklet), and is exported so the shape can be
 * unit-tested without a renderer — this is the only place in the app where a
 * silent arithmetic slip would show up as "the wave looks wrong on my phone"
 * and nowhere else.
 *
 * Guarantees, for any 0 ≤ level ≤ 1 and any phase: the result stays within
 * (0, 1], so a bar can never invert or overflow its box.
 */
export function waveAmplitude(
  index: number,
  phase: number,
  level: number,
  floor: number,
  swing: number,
  reactivity: number,
  spread: number,
): number {
  'worklet';
  const dist = Math.abs(index - CENTRE);
  // The ripple leaves the centre bar and travels out to both edges.
  const ripple = Math.sin(phase * TAU - dist * spread + DETUNE[index]);
  const r = 0.5 + 0.5 * ripple; // 0..1
  // Height arches toward the middle, the way a voice does on an oscilloscope —
  // a flat-topped block reads as a progress bar, not a voice.
  const arch = 1 - 0.16 * dist;
  const rest = floor + swing * r;
  return rest + (1 - rest) * level * reactivity * arch * (0.42 + 0.58 * r);
}

/**
 * One bar of the live wave. The style recomputes on the UI thread whenever the
 * phase clock ticks or a new mic sample lands — never in React.
 */
function WaveBar({
  index,
  height,
  color,
  phase,
  level,
  floor,
  swing,
  reactivity,
  spread,
}: WaveBarProps): React.JSX.Element {
  const style = useAnimatedStyle(() => {
    const amp = waveAmplitude(index, phase.value, level.value, floor, swing, reactivity, spread);
    return {
      transform: [{ scaleY: amp }],
      // Peaks brighten as well as grow: two channels for the same signal is
      // what separates a loud syllable from a merely tall one.
      opacity: 0.62 + 0.38 * amp,
    };
  });

  return <Animated.View style={[styles.bar, { height, backgroundColor: color }, style]} />;
}

// ── Component ────────────────────────────────────────────────────────────────
export function SeamControl({
  mode,
  activity = 'idle',
  hintTop = null,
  hintBottom = null,
  onToggle,
}: SeamControlProps): React.JSX.Element {
  const resolved = resolve(mode, activity);
  const isOff = resolved === 'reposo';
  const isPaused = resolved === 'paused';
  const isOn = resolved === 'escuchando' || resolved === 'traduciendo';
  // Both on-states run the wave formula; off/paused bars are flat and still.
  const wave = resolved === 'escuchando' || resolved === 'traduciendo' ? resolved : null;
  // The mic is only worth watching while we're the ones listening. In
  // 'traduciendo' the phone is the one making the noise.
  const level = useAudioLevel(resolved === 'escuchando');

  const enter = useSharedValue(0);
  const press = useSharedValue(0);
  const pop = useSharedValue(1);
  const invite = useSharedValue(0);   // breathing halo (off only)
  const glow = useSharedValue(0);     // inner glow (on only)
  const phase = useSharedValue(0);    // free-running wave clock (on only)
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

  // The wave clock. One linear sawtooth for all seven bars — the ripple's shape
  // lives in the per-bar formula, not in per-bar animations, so nothing can
  // drift out of step. Reset to 0 before (re)starting: withRepeat replays from
  // whatever the value happened to be when it began, and a cancelled clock left
  // mid-cycle would stretch the first lap.
  // (Do NOT reach for withDelay to stagger bars here — `withDelay(d,
  // withRepeat(...))` freezes on this Reanimated 4 + worklets build.)
  useEffect(() => {
    cancelAnimation(phase);
    if (wave === null) return;
    phase.value = 0;
    phase.value = withRepeat(
      withTiming(1, { duration: RIPPLE_PERIOD[wave], easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(phase);
  }, [wave, phase]);

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
      {
        scale:
          (0.86 + 0.14 * enter.value) *
          pop.value *
          (1 - 0.06 * press.value) *
          // The whole control swells a hair on a loud syllable. Small enough
          // that you feel it rather than watch it.
          (1 + 0.045 * level.value),
      },
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
  // The inner glow keeps its slow breath and takes the mic level on top, so
  // the pill lights from within as the room gets louder.
  const glowStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, glow.value + 0.55 * level.value),
  }));
  // A ring that pushes outward with the voice — the seam's own way of showing
  // sound leaving the centre of the table. Invisible in silence.
  const pulseStyle = useAnimatedStyle(() => ({
    opacity: 0.34 * level.value,
    transform: [{ scale: 1 + 0.12 * level.value }],
  }));
  // Hint labels breathe with the invite halo — same rhythm, gentler floor,
  // so the name and the "tappable" signal read as one gesture.
  const hintStyle = useAnimatedStyle(() => ({ opacity: 0.4 + 0.6 * invite.value }));
  const showHints = isOff && (hintTop !== null || hintBottom !== null);

  const waveMotion = wave === null ? null : WAVE_MOTION[wave];

  return (
    <Animated.View style={[styles.anchor, wrapStyle]} pointerEvents="box-none">
      {/* State lives in accessibilityState/Value (switch semantics), not baked
          into the label string — screen readers announce changes properly. */}
      <Pressable
        onPress={handlePress}
        onPressIn={() => { press.value = withSpring(1, motion.springSnappy); }}
        onPressOut={() => { press.value = withSpring(0, motion.springSnappy); }}
        hitSlop={10}
        accessibilityRole="switch"
        accessibilityState={{ checked: isOn, disabled: isPaused }}
        accessibilityValue={isPaused ? { text: 'paused — offline' } : undefined}
        accessibilityLabel="Hands-free"
        style={styles.press}>
        {/* Invite halo — a 1 px ring 4 px outside the pill, breathing when off. */}
        <Animated.View style={[styles.invite, inviteStyle]} pointerEvents="none" />

        {/* Level ring — same geometry as the invite halo (they are never on at
            the same time), pushed outward by the voice in the room. */}
        {isOn && <Animated.View style={[styles.pulse, pulseStyle]} pointerEvents="none" />}

        {/* Discoverability hints — one label per reader, gone forever after
            first use. */}
        {showHints && hintTop !== null && (
          <Animated.View style={[styles.hintAbove, hintStyle]} pointerEvents="none">
            <Text variant="serifSmall" style={styles.hintText} numberOfLines={1}>
              {hintTop}
            </Text>
          </Animated.View>
        )}
        {showHints && hintBottom !== null && (
          <Animated.View style={[styles.hintBelow, hintStyle]} pointerEvents="none">
            <Text variant="serifSmall" style={styles.hintText} numberOfLines={1}>
              {hintBottom}
            </Text>
          </Animated.View>
        )}

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

          {/* The wave. Live states share the phase clock and the mic level;
              reposo/paused are flat and still. */}
          <View style={styles.barRow}>
            {Array.from({ length: BAR_COUNT }, (_, i) =>
              waveMotion === null ? (
                <StillBar key={i} height={BAR_HEIGHT[resolved]} color={BAR_COLOR[resolved]} />
              ) : (
                <WaveBar
                  key={i}
                  index={i}
                  height={BAR_HEIGHT[resolved]}
                  color={BAR_COLOR[resolved]}
                  phase={phase}
                  level={level}
                  floor={waveMotion.floor}
                  swing={waveMotion.swing}
                  reactivity={waveMotion.reactivity}
                  spread={waveMotion.spread}
                />
              ),
            )}
          </View>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute', left: '50%', top: '50%' },
  press: { alignItems: 'center', justifyContent: 'center' },
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
  pulse: {
    position: 'absolute',
    top: -4,
    left: -4,
    right: -4,
    bottom: -4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.55)',
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
  glow: { alignItems: 'center', justifyContent: 'center' },
  // Hint labels sit just outside the pill on both sides of the seam. The
  // wide left/right box keeps the (nowrap) label centred on the pill without
  // the label's width affecting the anchor's layout.
  hintAbove: {
    position: 'absolute',
    bottom: '100%',
    left: -120,
    right: -120,
    marginBottom: 10,
    alignItems: 'center',
    transform: [{ rotate: '180deg' }],
  },
  hintBelow: {
    position: 'absolute',
    top: '100%',
    left: -120,
    right: -120,
    marginTop: 10,
    alignItems: 'center',
  },
  hintText: { color: 'rgba(255,255,255,0.72)' },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    // Prototype: 7 bars, 2px wide, 3px gap. Use real gap (no outer margins) so
    // the row width matches the prototype exactly.
    gap: 3,
  },
  bar: { width: 2, borderRadius: 2 },
});
