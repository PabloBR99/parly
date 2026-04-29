// PTTButton — the conversation's only interactive object.
//
// Object metaphor: a polished disc set into the surface of the phone, sitting
// in a watercolour bloom. The bloom — three offset stains in the speaker's
// palette, breathing on independent tempos — lives in `Bloom.tsx`. This
// component lays out the disc, the active outer ring, the inner glossy
// halo, and wires press handling.

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
import LinearGradient from 'react-native-linear-gradient';
import Svg, { Defs, RadialGradient, Stop, Circle } from 'react-native-svg';
import { color, motion, radius } from '../theme';
import { Waveform } from '../animations/Waveform';
import { Bloom } from '../animations/Bloom';
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
// BLOOM_SIZE is the visual reach of the watercolour. FOOTPRINT is the
// layout box the parent reserves for the PTT slot. Keeping FOOTPRINT
// smaller than BLOOM_SIZE lets the bloom paint OUTSIDE the slot — into
// surrounding chrome — which matches the mockup's "atmosphere of the
// disc" rather than "atmosphere of the slot".
//
// The mockup's bloom is 320px on a 380px phone — ~84% width, leaving a
// visible margin of dark dusk on either side. A previous pass bumped this
// to 480px (edge-to-edge) to compensate for RN missing `filter: blur(30px)`
// and `mix-blend-mode: screen`, but the result was wider than the mockup
// and lost the painted-island feel of the original. 340px keeps a small
// bump over the literal mockup spec to soften the falloff without making
// the bloom span the full width.
const BLOOM_SIZE = 340;
const FOOTPRINT = 200;

// Inner halo — a soft off-centre highlight inside the disc, equivalent to
// the mockup's `radial-gradient(circle at 35% 30%, white-6%, transparent
// 60%)`. Gives the disc the weight of a polished button rather than a
// drawn circle. Inset 6px on each side, so the highlight sits just inside
// the disc's hairline border.
const HALO_INSET = 6;
const HALO_SIZE = SIZE - HALO_INSET * 2;
const HALO_RADIUS = HALO_SIZE / 2;
const HALO_CX = 0.35;
const HALO_CY = 0.30;

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

  // Bloom palette key: comparing accent to the canonical A/B hexes keeps
  // PTTButtonProps unchanged for callers (they pass an accent, not a side).
  const side: 'A' | 'B' = accent === color.accentB ? 'B' : 'A';

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

  const disk: ViewStyle = {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    // Idle uses the speaker's accent for both fill and rim (low alpha) so the
    // disc reads as that speaker's territory even without a label inside.
    // Active is the same hue at higher intensity, with the canonical ring
    // colour for the rim.
    borderColor: active ? accentRing : `${accent}66`,    // ~40% accent
    backgroundColor: active ? `${accent}26` : `${accent}1A`, // 15% / 10% accent
    overflow: 'hidden',
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
        {/* Watercolour bloom — three SVG radial-gradient stains breathing on
            independent tempos. Centred on the disc; reaches outside the
            FOOTPRINT into surrounding chrome. */}
        <View style={styles.bloomLayer}>
          <Bloom side={side} size={BLOOM_SIZE} active={active} disabled={disabled} />
        </View>

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

        {/* Drop shadow — the disc rests on the surface like a polished
            puck. PLAN.md (§ Dusk) specifies `0 8px 24px rgba(0,0,0,0.55)`.
            We render a separate opaque underlay so Android `elevation`
            has a solid outline to cast the shadow from; the actual disc
            above keeps its semi-transparent accent tint and bloom
            interaction. Scales with the press transform so the shadow
            stays glued to the disc as it depresses. */}
        <Animated.View
          pointerEvents="none"
          style={[styles.shadowUnderlay, diskStyle, disabled && styles.disabled]}
        />

        {/* The disc itself — polished button with a body gradient
            (lit-from-above) and an off-centre inner halo. The body
            gradient gives the disc weight; without it the disc reads as
            a flat hairline circle. */}
        <Animated.View style={[disk, diskStyle, disabled && styles.disabled]}>
          {/* Body gradient — top edge slightly brighter than bottom so
              the disc looks lit from above, like a real polished surface. */}
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(255,255,255,0.06)', 'rgba(255,255,255,0.01)']}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          {/* Inner halo — SVG radial highlight at (35%, 30%), brighter than
              before so it reads as gloss without breaking the dark vibe. */}
          <View style={styles.haloLayer} pointerEvents="none">
            <Svg width={HALO_SIZE} height={HALO_SIZE}>
              <Defs>
                <RadialGradient
                  id={`disc-halo-${side}`}
                  cx={`${HALO_CX * 100}%`}
                  cy={`${HALO_CY * 100}%`}
                  rx="65%"
                  ry="65%"
                  fx={`${HALO_CX * 100}%`}
                  fy={`${HALO_CY * 100}%`}>
                  <Stop offset="0"    stopColor="#FFFFFF" stopOpacity="0.14" />
                  <Stop offset="0.35" stopColor="#FFFFFF" stopOpacity="0.04" />
                  <Stop offset="1"    stopColor="#FFFFFF" stopOpacity="0" />
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

          {active && <Waveform active color={accent} bars={5} height={30} />}
          {/* Idle state intentionally has no glyph or text inside the disc —
              the bloom + halo carry the affordance. The disc is only a
              polished surface to press, not a label-bearing widget. */}
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
  shadowUnderlay: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    // Solid black backing — mockup spec `0 8px 24px rgba(0,0,0,0.55)`.
    // Android elevation requires a non-transparent backgroundColor for
    // the outline provider to cast a shadow; the disc above re-tints
    // with the accent so this near-black underlay is invisible behind
    // it but still throws the drop shadow.
    backgroundColor: '#000',
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.55,
    shadowRadius: 24,
  },
  haloLayer: {
    position: 'absolute',
    top: HALO_INSET,
    left: HALO_INSET,
    width: HALO_SIZE,
    height: HALO_SIZE,
  },
  disabled: {
    opacity: 0.32,
  },
});

PTTButton.SIZE = SIZE;
PTTButton.FOOTPRINT = FOOTPRINT;

export const PTT_DEFAULT_ACCENT = color.fgMuted;
export const PTT_RADIUS = radius.pill;
