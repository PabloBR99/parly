// Seam — the horizon where warm and cool halves meet.
//
// One vertical LinearGradient cool → warm covers the seam zone (was two
// solid bands in the previous pass — that read as engineered stripes,
// not an atmospheric horizon). A bright SVG hairline crosses the centre
// and shimmers gently. When one side is speaking, the whole seam nudges
// toward the OTHER side — the partner's light retreating to make room.

import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import LinearGradient from 'react-native-linear-gradient';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from 'react-native-svg';
import { motion } from '../theme';

interface SeamProps {
  readonly activeSide: 'A' | 'B' | null;
}

const SEAM_HEIGHT = 140;
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
      withTiming(1, { duration: 9000, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    return () => cancelAnimation(shimmer);
  }, [shimmer]);

  // Container — the -50% centring + push translation, composed cleanly.
  const containerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -SEAM_HEIGHT / 2 + push.value }],
  }));

  // Hairline shimmer — opacity + scaleX on the GPU compositor. Kept small
  // (≤0.05 amplitude on opacity, ≤0.05 on scaleX) so the line doesn't
  // pulse like a loading state.
  const hairlineStyle = useAnimatedStyle(() => ({
    opacity: 0.65 + 0.35 * shimmer.value,
    transform: [{ scaleX: 0.95 + 0.05 * shimmer.value }],
  }));

  return (
    <Animated.View pointerEvents="none" style={[styles.container, containerStyle]}>
      {/* Single vertical haze: cool fades in from the top, meets warm at
          the centre, fades out at the bottom. The previous two-band
          approach read as two distinct stripes; one continuous gradient
          reads as a horizon. */}
      <LinearGradient
        pointerEvents="none"
        colors={[
          'rgba(168,178,255,0.00)',
          'rgba(168,178,255,0.16)',
          'rgba(168,178,255,0.20)',
          'rgba(255,179,122,0.20)',
          'rgba(255,179,122,0.16)',
          'rgba(255,179,122,0.00)',
        ]}
        locations={[0, 0.28, 0.45, 0.55, 0.72, 1]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      {/* Hairline — 5-stop horizontal gradient, fades to transparent at
          the screen edges, peaks bright (0.78) at the centre. */}
      <Animated.View style={[styles.hairline, hairlineStyle]}>
        <Svg width="100%" height={HAIRLINE_HEIGHT}>
          <Defs>
            <SvgLinearGradient id="seam-hairline" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0"    stopColor="#FFFFFF" stopOpacity="0" />
              <Stop offset="0.18" stopColor="#FFFFFF" stopOpacity="0.42" />
              <Stop offset="0.50" stopColor="#FFFFFF" stopOpacity="0.78" />
              <Stop offset="0.82" stopColor="#FFFFFF" stopOpacity="0.42" />
              <Stop offset="1"    stopColor="#FFFFFF" stopOpacity="0" />
            </SvgLinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height={HAIRLINE_HEIGHT} fill="url(#seam-hairline)" />
        </Svg>
      </Animated.View>
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
  hairline: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: SEAM_HEIGHT / 2 - HAIRLINE_HEIGHT / 2,
    height: HAIRLINE_HEIGHT,
  },
});
