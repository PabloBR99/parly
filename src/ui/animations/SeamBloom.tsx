// SeamBloom — the directional breath at the horizon, in hands-free mode.
//
// What it says: a turn just crossed the seam, and this is the way it went. In
// hands-free nobody presses anything, so the only evidence the machine took a
// turn is the text arriving. This gives that moment a direction, a beat before
// the words land.
//
// Why a radial bloom and not a band:
//   The first pass painted an 80 px tall rectangle filled with a
//   left-to-right gradient. A horizontal gradient leaves the *top and bottom*
//   as hard cuts, so it read as a pale rectangle with visible edges sliding
//   across the screen — and it sat at 7 % opacity permanently, so it was there
//   even when nothing had happened. Both are the failure mode Bloom.tsx
//   already documents: against near-black, a couple of percent of light held
//   in a straight line is enough to read as an edge.
//
//   This uses Bloom's 10-stop, gaussian-like falloff instead. Alpha asymptotes
//   toward zero in every direction, so there is no boundary anywhere to catch
//   the eye — the glow dissolves rather than ending. And it is at zero unless
//   a turn is actually crossing: atmosphere that is always on is just a tint.
//
// Why the listener's colour rather than white:
//   Peach for person A at the bottom, periwinkle for person B at the top — the
//   accents each half already owns. The horizon leaning warm tells the reader
//   at the bottom "this one is for you" without a glyph or a word. Colour
//   lives in the atmosphere; the chrome stays neutral.
//
// Why a circle stretched by a transform, never rx/ry on the gradient:
//   react-native-svg renders elliptical radial gradients with visible banding
//   (Bloom.tsx hit this too). A circular gradient squashed by a scaleY is
//   perfectly smooth.

import React, { useEffect, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { color } from '../theme';

const RISE_MS = 200;
const FALL_MS = 620;

/** How far the bloom drifts toward the reader receiving the turn. */
const DRIFT = 44;
/** Squashes the circle into something horizon-shaped. */
const FLATTEN = 0.5;
/** Peak alpha at the very centre. Everything else is the falloff curve. */
const PEAK_ALPHA = 0.24;
/** The bloom expands slightly as it dissipates: 0.92 → this. */
const SPREAD_MAX = 1.06;

// Footprint as a multiple of screen width.
//
// This number is load-bearing, not taste. The gradient reaches zero alpha at
// exactly half the SVG's box, so as long as that box — at its widest, which is
// SPREAD_MAX — fits inside the screen, every pixel where the bloom meets a
// container boundary is already fully transparent. There is then no clip that
// could ever be visible, whatever a given Android version decides to do about
// `overflow` on a child bigger than its parent.
//
//   size × SPREAD_MAX ≤ screen width   ⟹   FOOTPRINT ≤ 1 / 1.06 ≈ 0.943
//
// Vertically it has room to spare: half-height at max spread is ~97 pt plus
// 44 pt of drift, against half a screen. The previous pass sized the bloom at
// 1.45× the width, which put a live edge of the box off-screen and left the
// glow's boundary at the mercy of whatever clipped first.
const FOOTPRINT = 0.94;

export interface SeamBloomProps {
  /** 0 = idle, 1 = the turn is flowing down to person A, -1 = up to person B. */
  readonly pulseDirection: 0 | 1 | -1;
}

export function SeamBloom({ pulseDirection }: SeamBloomProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const size = Math.round(width * FOOTPRINT);

  const progress = useSharedValue(0); // brightness: 0 → 1 → 0
  const travel = useSharedValue(0);   // drift + spread: 0 → 1, one way only
  // Held across the fade. The prop drops back to 0 to re-arm the next pulse
  // long before this bloom has finished dissolving; re-reading it for the tint
  // would swap the colour mid-fade.
  const [flow, setFlow] = useState<1 | -1>(1);

  useEffect(() => {
    // pulseDirection === 0 is the re-arm, not a stop. The bloom owns its own
    // tail — cutting it short is what made the old band flick.
    if (pulseDirection === 0) return;
    setFlow(pulseDirection);
    progress.value = 0;
    travel.value = 0;
    progress.value = withSequence(
      withTiming(1, { duration: RISE_MS, easing: Easing.out(Easing.cubic) }),
      withTiming(0, { duration: FALL_MS, easing: Easing.inOut(Easing.sin) }),
    );
    // One-way, across the whole gesture: the glow leaves the seam and keeps
    // going as it fades, instead of bobbing back to where it started.
    travel.value = withTiming(1, {
      duration: RISE_MS + FALL_MS,
      easing: Easing.out(Easing.quad),
    });
  }, [pulseDirection, progress, travel]);

  useEffect(
    () => () => {
      cancelAnimation(progress);
      cancelAnimation(travel);
    },
    [progress, travel],
  );

  const bloomStyle = useAnimatedStyle(() => {
    // Expanding slightly as it dissipates reads as air, not as a moving object.
    const spread = 0.92 + (SPREAD_MAX - 0.92) * travel.value;
    return {
      opacity: progress.value,
      transform: [
        { translateY: flow * DRIFT * travel.value },
        { scaleX: spread },
        { scaleY: FLATTEN * spread },
      ],
    };
  });

  // flow 1 → the turn is landing on person A (bottom, warm).
  const tint = flow === 1 ? color.accentA : color.accentB;

  return (
    <View pointerEvents="none" style={styles.field}>
      {/* Absolutely positioned and centred on the seam by margin. Nothing here
          is content-sized, so no parent's box can be shrunk by the negative
          margins into something that clips the glow. */}
      <Animated.View
        style={[
          styles.bloom,
          { width: size, height: size, marginTop: -size / 2, marginLeft: -size / 2 },
          bloomStyle,
        ]}>
        <BloomCircle size={size} fill={tint} />
      </Animated.View>
    </View>
  );
}

/**
 * A 10-stop gaussian-like falloff (σ ≈ 0.32 in normalised radius), lifted from
 * Bloom.tsx. The outer third of the radius spends almost the whole alpha budget
 * dissolving: 2 % of peak at 88 %, 0.5 % at 95 %, zero at the boundary. That
 * long tail is the entire reason this has no visible edge.
 */
function BloomCircle({ size, fill }: { size: number; fill: string }): React.JSX.Element {
  const id = 'seam-bloom';
  const stops: readonly [string, number][] = [
    ['0', 1],
    ['0.08', 0.95],
    ['0.20', 0.78],
    ['0.35', 0.55],
    ['0.50', 0.32],
    ['0.65', 0.16],
    ['0.78', 0.07],
    ['0.88', 0.02],
    ['0.95', 0.005],
    ['1', 0],
  ];
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
          {stops.map(([offset, factor]) => (
            <Stop
              key={offset}
              offset={offset}
              stopColor={fill}
              stopOpacity={(PEAK_ALPHA * factor).toString()}
            />
          ))}
        </RadialGradient>
      </Defs>
      <Rect width={size} height={size} fill={`url(#${id})`} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  // Exactly the screen — a fixed box with no content-driven height, so the
  // bloom's own size can never change it.
  field: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'visible',
  },
  bloom: {
    position: 'absolute',
    top: '50%',
    left: '50%',
  },
});
