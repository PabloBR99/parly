// SeamShimmer — directional pulse along the horizon seam in hands-free mode.
//
// The seam is an 80 px tall band centred vertically on the screen — the
// natural near-black horizon of the DuskBackdrop gradient.  In HF mode,
// when a translation fires, a white gradient pulse sweeps through the band:
//   direction  1 → top→bottom (source person_b, translation flows down)
//   direction -1 → bottom→top (source person_a, translation flows up)
//
// In idle PTT / HF-idle: a faint shimmer sits at base opacity 0.07.
// During a pulse: gradient travels the full seam height in 400 ms, peak
// opacity 0.18, then returns to base.

import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import LinearGradient from 'react-native-linear-gradient';

const SEAM_HEIGHT = 80;
const PULSE_DURATION_MS = 400;
const BASE_OPACITY = 0.07;
const PEAK_OPACITY = 0.18;

export interface SeamShimmerProps {
  /** 0 = idle, 1 = top→bottom pulse, -1 = bottom→top pulse. */
  readonly pulseDirection: 0 | 1 | -1;
}

export function SeamShimmer({ pulseDirection }: SeamShimmerProps): React.JSX.Element {
  const progress = useSharedValue(0);
  const direction = useSharedValue<0 | 1 | -1>(0);

  useEffect(() => {
    if (pulseDirection === 0) {
      cancelAnimation(progress);
      progress.value = withTiming(0, { duration: 200 });
    } else {
      direction.value = pulseDirection;
      progress.value = 0;
      // Sweep in, hold briefly, sweep out — total ≈ PULSE_DURATION_MS.
      progress.value = withSequence(
        withTiming(1, { duration: PULSE_DURATION_MS * 0.55, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: PULSE_DURATION_MS * 0.45, easing: Easing.in(Easing.quad) }),
      );
    }
  }, [pulseDirection, progress, direction]);

  const shimmerStyle = useAnimatedStyle(() => {
    const opacity = BASE_OPACITY + (PEAK_OPACITY - BASE_OPACITY) * progress.value;
    // Translate the gradient through the seam height.
    // progress 0→1: gradient moves from one edge to the other.
    const travel = SEAM_HEIGHT * 0.8; // don't go all the way to the edge
    const translateY = direction.value * travel * (progress.value - 0.5);
    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.seam, shimmerStyle]}>
      <LinearGradient
        colors={['transparent', 'rgba(255,255,255,0.55)', 'transparent']}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  seam: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: SEAM_HEIGHT,
    top: '50%',
    marginTop: -(SEAM_HEIGHT / 2),
  },
});
