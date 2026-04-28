// PTTButton — the conversation's only interactive object.
//
// Object metaphor: a polished disc set into the surface of the phone, sitting
// in a watercolour bloom. The bloom is three offset, slightly-overlapping
// stains in the speaker's palette (warm for A, cool for B), each breathing on
// its own tempo so the stain "drifts" like ink drying on paper. When the
// speaker is active, the stains brighten and an outer ring breathes outward.
//
// Why three offset blobs instead of concentric halos: concentric circles read
// as sci-fi laser rings on a near-black surface. Asymmetric, palette-layered
// blobs read as pigment.

import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Text } from './Text';
import { color, motion, radius } from '../theme';
import { Waveform } from '../animations/Waveform';
import { haptics } from '../haptics';

interface PTTButtonProps {
  readonly label: string;        // language code, e.g. "es"
  readonly accent: string;       // canonical accent hex; picks the bloom palette
  readonly accentRing: string;   // active outer-ring tint
  readonly active: boolean;      // currently recording
  readonly disabled: boolean;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
  /** Inverted = render upside-down (top half of the conversation surface). */
  readonly inverted?: boolean;
}

const SIZE = 96;
// BLOOM_SIZE is the visual reach of each watercolour stain. FOOTPRINT is the
// layout box the parent reserves for the PTT. Keeping FOOTPRINT smaller than
// BLOOM_SIZE lets the bloom paint OUTSIDE the slot — into the chip above,
// the edge chrome below, and the seam zone — which is what makes the
// atmosphere feel painterly instead of disc-bound.
const BLOOM_SIZE = 340;
const FOOTPRINT = 240;

// Asymmetric stain offsets — the three blobs cluster around the disc but
// never share a centre, so their overlapping edges form a watercolour shape
// rather than concentric rings. Pushed harder than the original (which read
// as concentric on-device, against the mockup's painterly feel).
const TOP_OFFSET = { x: -38, y: -46 };
const MID_OFFSET = { x:  42, y:  28 };
const DEEP_OFFSET = { x:  -6, y:  52 };

// Per-stain breath tempos (ms). Coprime-ish so the stain phases never lock.
const TOP_PERIOD = 5400;
const MID_PERIOD = 6000;
const DEEP_PERIOD = 6600;

interface BloomPalette {
  readonly top: string;
  readonly mid: string;
  readonly deep: string;
}

const WARM_BLOOM: BloomPalette = {
  top: color.bloomWarmTop,
  mid: color.bloomWarmMid,
  deep: color.bloomWarmDeep,
};

const COOL_BLOOM: BloomPalette = {
  top: color.bloomCoolTop,
  mid: color.bloomCoolMid,
  deep: color.bloomCoolDeep,
};

// Inlined inside each worklet below — Reanimated 4's Babel plugin does not
// auto-promote module-scope arrow helpers, so calling a non-worklet from the
// UI thread crashes the screen on first frame. The math is trivial; one line
// per stain is the safe path.

export function PTTButton({
  label,
  accent,
  accentRing,
  active,
  disabled,
  onPressIn,
  onPressOut,
  inverted = false,
}: PTTButtonProps): React.JSX.Element {
  const press = useSharedValue(0);
  const ring = useSharedValue(0);

  // Per-stain breath drivers (0→1 looping, sin-eased).
  const breathTop = useSharedValue(0);
  const breathMid = useSharedValue(0);
  const breathDeep = useSharedValue(0);

  // Active brightens stains; disabled fades them to a near-invisible whisper.
  const activeBoost = useSharedValue(0);
  const disabledFade = useSharedValue(0);

  // Pick palette by comparing accent to canonical A/B hexes. Slight cheat
  // that keeps PTTButtonProps unchanged for callers.
  const palette: BloomPalette =
    accent === color.accentB ? COOL_BLOOM : WARM_BLOOM;

  // Active outer-ring breath.
  useEffect(() => {
    if (active) {
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
  }, [active, ring]);

  // Bloom breath — each stain on its own tempo so the cluster shape drifts.
  useEffect(() => {
    breathTop.value = withRepeat(
      withTiming(1, { duration: TOP_PERIOD, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    breathMid.value = withRepeat(
      withTiming(1, { duration: MID_PERIOD, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    breathDeep.value = withRepeat(
      withTiming(1, { duration: DEEP_PERIOD, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(breathTop);
      cancelAnimation(breathMid);
      cancelAnimation(breathDeep);
    };
  }, [breathTop, breathMid, breathDeep]);

  useEffect(() => {
    activeBoost.value = withTiming(active ? 1 : 0, { duration: motion.normal });
  }, [active, activeBoost]);

  useEffect(() => {
    disabledFade.value = withTiming(disabled ? 1 : 0, { duration: motion.normal });
  }, [disabled, disabledFade]);

  const handlePressIn = () => {
    if (disabled) return;
    haptics.tap();
    press.value = withSpring(1, motion.springSnappy);
    onPressIn();
  };

  const handlePressOut = () => {
    press.value = withSpring(0, motion.springSnappy);
    onPressOut();
  };

  // Disc grows on press; barely, like a real button being pressed in.
  const diskStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.05 * press.value }],
  }));

  // Outer breathing ring on active.
  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + ring.value * 0.55 }],
    opacity: 0.6 * (1 - ring.value),
  }));

  // Top stain — apricot / periwinkle. Drifts northwest.
  const topStainStyle = useAnimatedStyle(() => {
    const t = breathTop.value;
    const scale = (0.92 + 0.14 * t) + 0.06 * activeBoost.value;
    const dx = TOP_OFFSET.x + (-3 + 6 * t);
    const dy = TOP_OFFSET.y + (-3 + 6 * t);
    const baseOpacity = 0.37 + 0.36 * t;
    const boosted = baseOpacity + 0.25 * activeBoost.value;
    const faded = boosted * (1 - disabledFade.value) + 0.05 * disabledFade.value;
    return {
      opacity: faded,
      transform: [{ translateX: dx }, { translateY: dy }, { scale }],
    };
  });

  // Mid stain — peach / seafoam. Drifts southeast, opposite phase.
  const midStainStyle = useAnimatedStyle(() => {
    const t = breathMid.value;
    const scale = (0.94 + 0.10 * t) + 0.06 * activeBoost.value;
    const dx = MID_OFFSET.x + (3 - 6 * t);
    const dy = MID_OFFSET.y + (3 - 6 * t);
    const baseOpacity = 0.44 + 0.36 * t;
    const boosted = baseOpacity + 0.25 * activeBoost.value;
    const faded = boosted * (1 - disabledFade.value) + 0.05 * disabledFade.value;
    return {
      opacity: faded,
      transform: [{ translateX: dx }, { translateY: dy }, { scale }],
    };
  });

  // Deep stain — terracotta / iris. Drifts south.
  const deepStainStyle = useAnimatedStyle(() => {
    const t = breathDeep.value;
    const scale = (0.95 + 0.10 * t) + 0.06 * activeBoost.value;
    const dx = DEEP_OFFSET.x + (-3 + 6 * t);
    const dy = DEEP_OFFSET.y + (3 - 6 * t);
    const baseOpacity = 0.52 + 0.36 * t;
    const boosted = baseOpacity + 0.25 * activeBoost.value;
    const faded = boosted * (1 - disabledFade.value) + 0.05 * disabledFade.value;
    return {
      opacity: faded,
      transform: [{ translateX: dx }, { translateY: dy }, { scale }],
    };
  });

  const labelTone = disabled ? 'fgGhost' : active ? 'fg' : 'fgMuted';

  const disk: ViewStyle = {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: active ? accentRing : color.hairlineStrong,
    backgroundColor: active ? `${accent}1A` : color.surface1,
  };

  return (
    <Pressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={`Microphone ${label}`}
      accessibilityState={{ disabled, busy: active }}>
      <View
        style={[
          styles.wrap,
          { width: FOOTPRINT, height: FOOTPRINT },
          inverted && styles.inverted,
        ]}>
        {/* Bloom — three offset stains forming an asymmetric watercolour. */}
        <Animated.View
          pointerEvents="none"
          style={[styles.bloom, { backgroundColor: palette.top }, topStainStyle]}
        />
        <Animated.View
          pointerEvents="none"
          style={[styles.bloom, { backgroundColor: palette.mid }, midStainStyle]}
        />
        <Animated.View
          pointerEvents="none"
          style={[styles.bloom, { backgroundColor: palette.deep }, deepStainStyle]}
        />
        {/* Active outward-breathing ring. */}
        {active && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.ring,
              {
                width: SIZE,
                height: SIZE,
                borderRadius: SIZE / 2,
                borderColor: accentRing,
              },
              ringStyle,
            ]}
          />
        )}
        {/* The disc itself. */}
        <Animated.View style={[disk, diskStyle, disabled && styles.disabled]}>
          {active ? (
            <Waveform active color={accent} bars={5} height={30} />
          ) : (
            <View style={styles.labelStack}>
              {/* Subtle horizontal mic-affordance: a clean tick line above
                  the language code. Replaces the old puck-dot. */}
              <View
                style={{
                  width: 14,
                  height: 1.5,
                  borderRadius: 1,
                  backgroundColor: disabled ? color.fgGhost : color.fgFaint,
                  marginBottom: 8,
                }}
              />
              <Text variant="serifSmall" tone={labelTone} style={styles.codeLabel}>
                {label.toLowerCase()}
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
  bloom: {
    position: 'absolute',
    width: BLOOM_SIZE,
    height: BLOOM_SIZE,
    borderRadius: BLOOM_SIZE / 2,
  },
  ring: {
    position: 'absolute',
    borderWidth: 1.5,
  },
  labelStack: {
    alignItems: 'center',
  },
  codeLabel: {
    fontSize: 13,
    letterSpacing: 0.8,
  },
  disabled: {
    opacity: 0.32,
  },
});

PTTButton.SIZE = SIZE;
PTTButton.FOOTPRINT = FOOTPRINT;

export const PTT_DEFAULT_ACCENT = color.fgMuted;
export const PTT_RADIUS = radius.pill;
