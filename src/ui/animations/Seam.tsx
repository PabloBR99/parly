// Seam — the soft horizontal band where the warm and cool halves meet.
//
// Not a divider, an encounter: a faked vertical gradient built from three
// stacked translucent bands (cool above, warm below, hairline at centre)
// because the project carries no gradient or SVG dependency. The hairline
// shimmers in idle; when one side is speaking, the whole seam nudges
// toward the OTHER side — the partner's light retreating to make room.

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
import { color, motion } from '../theme';

interface SeamProps {
  readonly activeSide: 'A' | 'B' | null;
}

const BAND_HEIGHT = 56;
const SEAM_HEIGHT = 120;
const PUSH_PX = 6;

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

  // The container holds the -50% centring transform; we stack the push
  // translation on top so it composes cleanly with the static centring.
  const containerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -SEAM_HEIGHT / 2 + push.value }],
  }));

  // scaleX (not width) keeps the shimmer on the GPU compositor.
  const hairlineStyle = useAnimatedStyle(() => ({
    opacity: 0.4 + 0.6 * shimmer.value,
    transform: [{ scaleX: 0.92 + 0.08 * shimmer.value }],
  }));

  // pointerEvents="none" so the seam never intercepts PTT presses near
  // the centre of the screen.
  return (
    <Animated.View pointerEvents="none" style={[styles.container, containerStyle]}>
      <View style={styles.coolBand} />
      <Animated.View style={[styles.hairline, hairlineStyle]} />
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
    left: '12%',
    right: '12%',
    top: SEAM_HEIGHT / 2 - 0.5,
    height: 1,
    backgroundColor: color.seamLine,
  },
});
