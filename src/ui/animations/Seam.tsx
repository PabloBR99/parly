// Seam — the horizon where warm and cool halves meet.
//
// Not a divider, an encounter: a soft warm/cool transition zone (faked
// with two stacked translucent bands since RN can't blur a region) plus
// a CRISP HAIRLINE through the middle that fades from transparent at the
// edges to a clear bright line at the centre. The hairline gives the seam
// a real horizon line — without it, the warm/cool bands just blend into
// the gradient.
//
// The hairline is rendered as an SVG horizontal LinearGradient (transparent
// → bright → transparent) instead of a flat View, so it actually fades at
// the edges instead of butting up hard against the screen sides.
//
// Idle: the hairline shimmers softly. Active: the whole seam nudges toward
// the OTHER side — the partner's light retreating to make room.

import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { color, motion } from '../theme';

interface SeamProps {
  readonly activeSide: 'A' | 'B' | null;
}

const BAND_HEIGHT = 56;
const SEAM_HEIGHT = 120;
const PUSH_PX = 6;
const HAIRLINE_HEIGHT = 1.5;

export function Seam({ activeSide }: SeamProps): React.JSX.Element {
  // Push: A (warm, bottom) speaking → seam shifts UP (negative).
  //       B (cool, top) speaking    → seam shifts DOWN (positive).
  const push = useSharedValue(0);
  useEffect(() => {
    const target = activeSide === 'A' ? -PUSH_PX : activeSide === 'B' ? PUSH_PX : 0;
    push.value = withTiming(target, {
      duration: motion.slow,
      easing: Easing.out(Easing.quad),
    });
    return () => cancelAnimation(push);
  }, [activeSide, push]);

  const shimmer = useSharedValue(0);
  useEffect(() => {
    shimmer.value = withRepeat(
      withTiming(1, { duration: 8000, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    return () => cancelAnimation(shimmer);
  }, [shimmer]);

  // Container — the -50% centring + push translation, composed cleanly.
  const containerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -SEAM_HEIGHT / 2 + push.value }],
  }));

  // Hairline — opacity + scaleX shimmer on the GPU compositor.
  const hairlineStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + 0.45 * shimmer.value,
    transform: [{ scaleX: 0.94 + 0.06 * shimmer.value }],
  }));

  // pointerEvents="none" so the seam never intercepts PTT presses near
  // the centre of the screen.
  return (
    <Animated.View pointerEvents="none" style={[styles.container, containerStyle]}>
      <View style={styles.coolBand} />
      <Animated.View style={[styles.hairline, hairlineStyle]}>
        <Svg width="100%" height={HAIRLINE_HEIGHT}>
          <Defs>
            <LinearGradient id="seam-hairline" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0"    stopColor="#FFFFFF" stopOpacity="0" />
              <Stop offset="0.20" stopColor="#FFFFFF" stopOpacity="0.32" />
              <Stop offset="0.50" stopColor="#FFFFFF" stopOpacity="0.55" />
              <Stop offset="0.80" stopColor="#FFFFFF" stopOpacity="0.32" />
              <Stop offset="1"    stopColor="#FFFFFF" stopOpacity="0" />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height={HAIRLINE_HEIGHT} fill="url(#seam-hairline)" />
        </Svg>
      </Animated.View>
      <View style={styles.warmBand} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    height: SEAM_HEIGHT,
  },
  coolBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: BAND_HEIGHT,
    backgroundColor: color.seamCool,
  },
  warmBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: BAND_HEIGHT,
    backgroundColor: color.seamWarm,
  },
  hairline: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: SEAM_HEIGHT / 2 - HAIRLINE_HEIGHT / 2,
    height: HAIRLINE_HEIGHT,
  },
});
