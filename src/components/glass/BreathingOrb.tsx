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
  /** When true the orb is dim and static (other side is active). */
  readonly dimmed?: boolean;
}

export function BreathingOrb({ dimmed = false }: Props): React.JSX.Element {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(dimmed ? 0.08 : 0.25);

  useEffect(() => {
    cancelAnimation(scale);
    cancelAnimation(opacity);

    if (dimmed) {
      scale.value = withTiming(1, { duration: 400 });
      opacity.value = withTiming(0.08, { duration: 400 });
    } else {
      scale.value = withRepeat(
        withSequence(
          withTiming(1.08, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
          withTiming(1.0, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      );
      opacity.value = withRepeat(
        withSequence(
          withTiming(0.6, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.25, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
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
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
});
