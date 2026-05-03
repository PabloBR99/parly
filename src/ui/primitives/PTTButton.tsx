// PTTButton — the conversation's only interactive object.
//
// Object metaphor: a polished disc set into the surface of the phone, sitting
// in a watercolour bloom. The bloom — three offset stains in the speaker's
// palette, breathing on independent tempos — lives in `Bloom.tsx`. This
// component lays out the disc, the active outer ring, the inner glossy
// halo, and wires press handling.

import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
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
import Svg, { Circle, Defs, Mask, RadialGradient, Rect, Stop } from 'react-native-svg';
import { color, font, motion, radius } from '../theme';
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

// SIZE 108 — the mockup uses 96 dp on a 380 dp design canvas (25 %
// width). On a CMF Phone 1 (412 dp wide) 96 dp reads visibly small;
// 108 dp restores the same proportional weight. Interior content (tick
// top offset, lang fontSize, lang marginTop) is scaled by 1.125 to keep
// the same internal balance.
const SIZE = 108;
// BLOOM_SIZE is the visual reach of the watercolour. FOOTPRINT is the
// layout box the parent reserves for the PTT slot. Keeping FOOTPRINT
// smaller than BLOOM_SIZE lets the bloom paint OUTSIDE the slot — into
// surrounding chrome — which matches the mockup's "atmosphere of the
// disc" rather than "atmosphere of the slot".
//
// The mockup's bloom is 320px on a 380px phone — ~84% width. RN can't do
// `filter: blur(30px)` or `mix-blend-mode: screen`, so a too-narrow
// bloom (340–400 px) had to either show distinct stain centres or end
// at a visible circular halo. 460 px gives the gaussian-like 10-stop
// falloff in `Bloom.tsx` enough physical room to asymptote: the alpha
// is already below 1% combined past 88% radius, so the gradient never
// reaches a defined edge — it simply dissolves into the dusk.
const BLOOM_SIZE = 460;
const FOOTPRINT = 200;

// Inner halo — match the mockup's `radial-gradient(circle at 35% 30%,
// rgba(255,255,255,0.06), transparent 60%)`. Earlier passes used 14 % at
// peak which lit the disc up far brighter than the mockup intended;
// dropping to 6 % restores the "soft polished glass" feel rather than a
// glow. Inset 6 px on each side so the highlight sits just inside the
// hairline border.
const HALO_INSET = 6;
const HALO_SIZE = SIZE - HALO_INSET * 2;
const HALO_RADIUS = HALO_SIZE / 2;
const HALO_CX = 0.35;
const HALO_CY = 0.30;

// Drop shadow — replicates `box-shadow: 0 8px 24px rgba(0,0,0,0.55)` from
// the mockup. We render an SVG <Circle> filled with a radial gradient,
// centred 8 px below the disc, then mask out the disc area itself so the
// shadow only paints OUTSIDE the disc (densest at the bottom edge, softer
// up the sides, almost invisible at the top — same falloff CSS produces).
// The previous "ring" attempts couldn't manage this because a single
// radial gradient centred on the disc can't be both opaque outside and
// transparent inside; the mask makes it possible.
const SHADOW_CANVAS = 192;
const SHADOW_DISC_CX = SHADOW_CANVAS / 2;
const SHADOW_DISC_CY = SHADOW_CANVAS / 2;
const SHADOW_OFFSET_Y = 8;
const SHADOW_CIRCLE_CY = SHADOW_DISC_CY + SHADOW_OFFSET_Y;
const SHADOW_REACH = SIZE / 2 + 32;

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

  // Shadow halo follows the press scale only — the 8 px downward offset
  // is now baked into the SVG geometry (the shadow circle is drawn 8 px
  // below the masked disc within the canvas), so we don't need to
  // translate the canvas itself. Animated style stays separate from
  // `diskStyle` because RN does not merge `transform` across style
  // arrays: applying both to the same Animated.View would clobber one.
  const shadowStyle = useAnimatedStyle(() => ({
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
    // Idle: white-on-white hairline border (mockup spec
    // `border: 1px solid rgba(255,255,255,0.10)`) and a transparent
    // background — the disc reads as a polished neutral object whose
    // colour comes from the bloom passing through it. Active: tinted
    // with the accent so it's visibly "lit" while recording.
    borderColor: active ? accentRing : 'rgba(255,255,255,0.10)',
    backgroundColor: active ? `${accent}26` : 'transparent',
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

        {/* Drop shadow — SVG circle centred 8 px below the disc, masked
            to exclude the disc area so the cloud only paints outside the
            disc shape. Densest at the bottom edge, fading up the sides,
            almost invisible at the top — the same falloff a CSS
            `0 8px 24px rgba(0,0,0,0.55)` produces. */}
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
                <Circle
                  cx={SHADOW_DISC_CX}
                  cy={SHADOW_DISC_CY}
                  r={SIZE / 2}
                  fill="black"
                />
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

        {/* The disc itself — polished button with a body gradient
            (lit-from-above) and an off-centre inner halo. The body
            gradient gives the disc weight; without it the disc reads as
            a flat hairline circle. */}
        <Animated.View style={[disk, diskStyle, disabled && styles.disabled]}>
          {/* Body gradient — 6 % → 0 % white. Slightly more depth than the
              original 4 % → 1 %; the additional 2 % at the top edge reads
              as lit-from-above without brightening the lower half. */}
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(255,255,255,0.06)', 'rgba(255,255,255,0.00)']}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          {/* Inner halo — off-centre gloss at (35%, 30%). Raised from 6% to
              10% at centre for a more pronounced glass-jewel catch-light;
              the mid-stop at 45% eases the falloff so it reads as polish,
              not a visible gradient ring. */}
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

          {/* Idle content — tick (14 × 1.5 pt mic-affordance at 40 % white)
              positioned 32 px from the disc top, then the language code
              in serif italic 14 pt at 62 % white, 14 px below the tick.
              Mockup spec exactly. While recording the Waveform animation
              replaces both. */}
          {active ? (
            <Waveform active color={accent} bars={5} height={30} />
          ) : (
            <View style={styles.discIdleContent} pointerEvents="none">
              <View style={styles.tick} />
              <Text style={styles.lang}>{label}</Text>
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
    // Both the disc's downward shadow offset AND the press-scale
    // transform are applied via `shadowStyle` (animated). RN doesn't
    // merge `transform` across style arrays, so a static translateY
    // here would clobber the scale.
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
  lang: {
    marginTop: 16,
    fontFamily: font.serifFamily,
    fontStyle: 'italic',
    fontSize: 16,
    color: 'rgba(255,255,255,0.62)',
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
