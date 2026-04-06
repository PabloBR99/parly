import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

interface Props {
  /** When true the orb is nearly invisible (other side is active). */
  readonly dimmed?: boolean;
}

export function BreathingOrb({ dimmed = false }: Props): React.JSX.Element {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(dimmed ? 0.04 : 0.22);

  useEffect(() => {
    cancelAnimation(scale);
    cancelAnimation(opacity);

    if (dimmed) {
      scale.value = withTiming(1, { duration: 500 });
      opacity.value = withTiming(0.04, { duration: 500 });
    } else {
      // Slow, human-paced breath — 3 s per phase
      scale.value = withRepeat(
        withSequence(
          withTiming(1.06, { duration: 3000, easing: Easing.inOut(Easing.ease) }),
          withTiming(1.0, { duration: 3000, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      );
      opacity.value = withRepeat(
        withSequence(
          withTiming(0.50, { duration: 3000, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.22, { duration: 3000, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      );
    }
  }, [dimmed, scale, opacity]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={[styles.ring, animStyle]}>
      <View style={styles.dot} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  ring: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 0.5,
    borderColor: 'rgba(255, 255, 255, 0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: 'rgba(255, 255, 255, 0.30)',
  },
});
