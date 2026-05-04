// PTTButton — the conversation's only interactive object.
//
// Object metaphor: a polished disc set into the surface of the phone, sitting
// in a watercolour bloom. The bloom — three offset stains in the speaker's
// palette, breathing on independent tempos — lives in `Bloom.tsx`. This
// component lays out the disc, the active outer ring, the inner glossy
// halo, and wires press handling.
//
// Hands-free (HF) mode adds a `mode` prop that drives distinct visual states
// without requiring the caller to track `active` separately. See `DiscMode`.

import React, { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import LinearGradient from 'react-native-linear-gradient';
import Svg, { Circle, Defs, Mask, RadialGradient, Rect, Stop } from 'react-native-svg';
import { color, font, motion, radius } from '../theme';
import { Waveform } from '../animations/Waveform';
import { Bloom } from '../animations/Bloom';
import { haptics } from '../haptics';

// ── Disc mode ────────────────────────────────────────────────────────────────

export type DiscMode =
  | { kind: 'ptt-idle' }
  | { kind: 'ptt-active' }
  /** Both discs while HF is on but no one is speaking. */
  | { kind: 'hf-idle' }
  /** VAD detected voice on this disc's speaker. */
  | { kind: 'hf-source-active' }
  /** TTS is playing through this disc's speaker (translation target). */
  | { kind: 'hf-target-speaking' };

// ── Props ─────────────────────────────────────────────────────────────────────

interface PTTButtonProps {
  readonly label: string;        // language code, e.g. "es"
  readonly accent: string;       // canonical accent hex; picks the bloom palette
  readonly accentRing: string;   // active outer-ring tint
  readonly active: boolean;      // used when `mode` is not provided (PTT legacy)
  readonly disabled: boolean;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
  /** Drives HF visual states. When provided it overrides `active`. */
  readonly mode?: DiscMode;
  /** Single-tap handler — used to exit HF mode (fires instead of pressIn/Out). */
  readonly onTap?: () => void;
  /** Inverted = render upside-down (top half of the conversation surface). */
  readonly inverted?: boolean;
}

// ── Layout constants ─────────────────────────────────────────────────────────

const SIZE = 108;
const BLOOM_SIZE = 460;
const FOOTPRINT = 200;
const HALO_INSET = 6;
const HALO_SIZE = SIZE - HALO_INSET * 2;
const HALO_RADIUS = HALO_SIZE / 2;
const HALO_CX = 0.35;
const HALO_CY = 0.30;
const SHADOW_CANVAS = 192;
const SHADOW_DISC_CX = SHADOW_CANVAS / 2;
const SHADOW_DISC_CY = SHADOW_CANVAS / 2;
const SHADOW_OFFSET_Y = 8;
const SHADOW_CIRCLE_CY = SHADOW_DISC_CY + SHADOW_OFFSET_Y;
const SHADOW_REACH = SIZE / 2 + 32;

// HF idle: dot pulses every 4 s (half the seam-shimmer period of 8 s).
const HF_DOT_PULSE_MS = 4_000;

export function PTTButton({
  label,
  accent,
  accentRing,
  active,
  disabled,
  onPressIn,
  onPressOut,
  mode,
  onTap,
  inverted = false,
}: PTTButtonProps): React.JSX.Element {
  // Derive effective mode from either the `mode` prop or the legacy `active` flag.
  const effectiveMode: DiscMode = mode ?? (active ? { kind: 'ptt-active' } : { kind: 'ptt-idle' });
  const isHf = effectiveMode.kind.startsWith('hf-');
  const isActive =
    effectiveMode.kind === 'ptt-active' ||
    effectiveMode.kind === 'hf-source-active';

  const press = useSharedValue(0);
  const ring = useSharedValue(0);
  const inhale = useSharedValue(1);
  const hfDotPulse = useSharedValue(0);

  // Bloom palette key.
  const side: 'A' | 'B' = accent === color.accentB ? 'B' : 'A';

  // Track HF entry for the inhale animation.
  const wasHfRef = useRef(false);
  useEffect(() => {
    const wasHf = wasHfRef.current;
    wasHfRef.current = isHf;
    if (!wasHf && isHf) {
      inhale.value = withSequence(
        withTiming(1.08, { duration: 350, easing: Easing.inOut(Easing.ease) }),
        withTiming(1.0, { duration: 350, easing: Easing.inOut(Easing.ease) }),
      );
    }
    if (wasHf && !isHf) {
      cancelAnimation(inhale);
      inhale.value = 1;
    }
  }, [isHf, inhale]);

  // Active outer-ring breath (PTT and hf-source-active).
  useEffect(() => {
    if (isActive) {
      ring.value = 0;
      ring.value = withRepeat(
        withTiming(1, { duration: 1600, easing: Easing.out(Easing.quad) }),
        -1,
        false,
      );
    } else {
      cancelAnimation(ring);
      ring.value = withTiming(0, { duration: motion.fast });
    }
    return () => cancelAnimation(ring);
  }, [isActive, ring]);

  // HF-idle dot pulse.
  useEffect(() => {
    if (effectiveMode.kind === 'hf-idle') {
      hfDotPulse.value = withRepeat(
        withSequence(
          withTiming(1, { duration: HF_DOT_PULSE_MS * 0.1, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: HF_DOT_PULSE_MS * 0.9, easing: Easing.in(Easing.quad) }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(hfDotPulse);
      hfDotPulse.value = 0;
    }
    return () => cancelAnimation(hfDotPulse);
  }, [effectiveMode.kind, hfDotPulse]);

  const handlePressIn = () => {
    if (disabled || isHf) return;
    haptics.tap();
    press.value = withSpring(1, motion.springSnappy);
    onPressIn();
  };

  const handlePressOut = () => {
    if (isHf) return;
    press.value = withSpring(0, motion.springSnappy);
    onPressOut();
  };

  const handleTap = () => {
    if (disabled || !isHf) return;
    haptics.tap();
    onTap?.();
  };

  // Disc scale: press scale in PTT, inhale in HF transition, plus mode breathing.
  const diskStyle = useAnimatedStyle(() => ({
    transform: [{ scale: (1 + 0.05 * press.value) * inhale.value }],
  }));

  const shadowStyle = useAnimatedStyle(() => ({
    transform: [{ scale: (1 + 0.05 * press.value) * inhale.value }],
  }));

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + ring.value * 0.55 }],
    opacity: 0.6 * (1 - ring.value),
  }));

  // HF-target-speaking: radial shimmer inside disc (white, 0.04→0.10→0.04, 1.6 s period).
  const targetShimmer = useSharedValue(0);
  useEffect(() => {
    if (effectiveMode.kind === 'hf-target-speaking') {
      targetShimmer.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 800, easing: Easing.inOut(Easing.sin) }),
          withTiming(0, { duration: 800, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(targetShimmer);
      targetShimmer.value = 0;
    }
    return () => cancelAnimation(targetShimmer);
  }, [effectiveMode.kind, targetShimmer]);

  const targetShimmerStyle = useAnimatedStyle(() => ({
    opacity: 0.04 + 0.06 * targetShimmer.value,
  }));

  // HF idle: lang label at 45% opacity; normal: 62%.
  const langOpacity = effectiveMode.kind === 'hf-idle' ? 0.45 : 0.62;

  // Bloom intensity by mode.
  const bloomIntensity =
    effectiveMode.kind === 'hf-idle' ? 0.30
    : effectiveMode.kind === 'hf-target-speaking' ? 0.60
    : 1.0;

  const disk: ViewStyle = {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: isActive ? accentRing : 'rgba(255,255,255,0.10)',
    backgroundColor: isActive ? `${accent}26` : 'transparent',
    overflow: 'hidden',
  };

  // hf-target-speaking: static accent ring (no breathing animation).
  const showStaticRing = effectiveMode.kind === 'hf-target-speaking';

  return (
    <Pressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={isHf ? handleTap : undefined}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={`Microphone ${label}`}
      accessibilityState={{ disabled, busy: isActive }}>
      <View
        style={[
          styles.wrap,
          { width: FOOTPRINT, height: FOOTPRINT },
          inverted && styles.inverted,
        ]}>
        {/* Watercolour bloom. */}
        <View style={styles.bloomLayer}>
          <Bloom
            side={side}
            size={BLOOM_SIZE}
            active={isActive}
            disabled={disabled}
            intensity={bloomIntensity}
          />
        </View>

        {/* Active outward-breathing ring. */}
        {isActive && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.ring,
              { width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderColor: accentRing },
              ringStyle,
            ]}
          />
        )}

        {/* HF target-speaking: static accent ring. */}
        {showStaticRing && (
          <View
            pointerEvents="none"
            style={[
              styles.ring,
              { width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderColor: accentRing, borderWidth: 1.5 },
            ]}
          />
        )}

        {/* Drop shadow. */}
        <Animated.View
          pointerEvents="none"
          style={[styles.shadowLayer, shadowStyle, disabled && styles.disabled]}>
          <Svg width={SHADOW_CANVAS} height={SHADOW_CANVAS}>
            <Defs>
              <RadialGradient
                id="ptt-shadow-fall"
                cx={SHADOW_DISC_CX}
                cy={SHADOW_CIRCLE_CY}
                r={SHADOW_REACH}
                fx={SHADOW_DISC_CX}
                fy={SHADOW_CIRCLE_CY}
                gradientUnits="userSpaceOnUse">
                <Stop offset="0"   stopColor="#000" stopOpacity="0.55" />
                <Stop offset="0.5" stopColor="#000" stopOpacity="0.32" />
                <Stop offset="0.8" stopColor="#000" stopOpacity="0.10" />
                <Stop offset="1"   stopColor="#000" stopOpacity="0" />
              </RadialGradient>
              <Mask id="ptt-shadow-mask">
                <Rect width={SHADOW_CANVAS} height={SHADOW_CANVAS} fill="white" />
                <Circle cx={SHADOW_DISC_CX} cy={SHADOW_DISC_CY} r={SIZE / 2} fill="black" />
              </Mask>
            </Defs>
            <Circle
              cx={SHADOW_DISC_CX}
              cy={SHADOW_CIRCLE_CY}
              r={SHADOW_REACH}
              fill="url(#ptt-shadow-fall)"
              mask="url(#ptt-shadow-mask)"
            />
          </Svg>
        </Animated.View>

        {/* The disc. */}
        <Animated.View style={[disk, diskStyle, disabled && styles.disabled]}>
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(255,255,255,0.06)', 'rgba(255,255,255,0.00)']}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          {/* Inner halo. */}
          <View style={styles.haloLayer} pointerEvents="none">
            <Svg width={HALO_SIZE} height={HALO_SIZE}>
              <Defs>
                <RadialGradient
                  id={`disc-halo-${side}`}
                  cx={`${HALO_CX * 100}%`}
                  cy={`${HALO_CY * 100}%`}
                  rx="65%" ry="65%"
                  fx={`${HALO_CX * 100}%`}
                  fy={`${HALO_CY * 100}%`}>
                  <Stop offset="0"    stopColor="#FFFFFF" stopOpacity="0.10" />
                  <Stop offset="0.45" stopColor="#FFFFFF" stopOpacity="0.02" />
                  <Stop offset="0.7"  stopColor="#FFFFFF" stopOpacity="0" />
                </RadialGradient>
              </Defs>
              <Circle
                cx={HALO_RADIUS}
                cy={HALO_RADIUS}
                r={HALO_RADIUS}
                fill={`url(#disc-halo-${side})`}
              />
            </Svg>
          </View>

          {/* HF target-speaking: radial shimmer from centre. */}
          {effectiveMode.kind === 'hf-target-speaking' && (
            <Animated.View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, targetShimmerStyle]}>
              <Svg width={SIZE} height={SIZE}>
                <Defs>
                  <RadialGradient
                    id={`hf-shimmer-${side}`}
                    cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
                    <Stop offset="0"   stopColor="#FFFFFF" stopOpacity="1" />
                    <Stop offset="0.6" stopColor="#FFFFFF" stopOpacity="0.4" />
                    <Stop offset="1"   stopColor="#FFFFFF" stopOpacity="0" />
                  </RadialGradient>
                </Defs>
                <Circle
                  cx={SIZE / 2} cy={SIZE / 2} r={SIZE / 2}
                  fill={`url(#hf-shimmer-${side})`}
                />
              </Svg>
            </Animated.View>
          )}

          {/* Disc content by mode. */}
          {isActive ? (
            <Waveform active color={accent} bars={5} height={30} />
          ) : effectiveMode.kind === 'hf-idle' ? (
            <View style={styles.discIdleContent} pointerEvents="none">
              {/* Pulsing 2 px dot replaces the tick in HF idle. */}
              <Animated.View style={[styles.hfDot, { opacity: 0.5 + 0.5 * hfDotPulse.value }]} />
              <Text style={[styles.lang, { color: `rgba(255,255,255,${langOpacity})` }]}>
                {label}
              </Text>
            </View>
          ) : (
            <View style={styles.discIdleContent} pointerEvents="none">
              <View style={styles.tick} />
              <Text style={[styles.lang, { color: `rgba(255,255,255,${langOpacity})` }]}>
                {label}
              </Text>
            </View>
          )}
        </Animated.View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  inverted: {
    transform: [{ rotate: '180deg' }],
  },
  bloomLayer: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    borderWidth: 1.5,
  },
  shadowLayer: {
    position: 'absolute',
    width: SHADOW_CANVAS,
    height: SHADOW_CANVAS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  haloLayer: {
    position: 'absolute',
    top: HALO_INSET,
    left: HALO_INSET,
    width: HALO_SIZE,
    height: HALO_SIZE,
  },
  discIdleContent: {
    position: 'absolute',
    top: 36,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  tick: {
    width: 16,
    height: 1.5,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.40)',
  },
  hfDot: {
    width: 2,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#FFFFFF',
  },
  lang: {
    marginTop: 16,
    fontFamily: font.serifFamily,
    fontStyle: 'italic',
    fontSize: 16,
    letterSpacing: 1.2,
  },
  disabled: {
    opacity: 0.32,
  },
});

PTTButton.SIZE = SIZE;
PTTButton.FOOTPRINT = FOOTPRINT;

export const PTT_DEFAULT_ACCENT = color.fgMuted;
export const PTT_RADIUS = radius.pill;
