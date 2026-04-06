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

/**
 * Single breathing dot — the heartbeat divider between the two halves.
 * Opacity 0.15→0.50, scale 1.0→1.3, 4 000ms cycle.
 */
export function BreathingDot(): React.JSX.Element {
  const opacity = useSharedValue(0.15);
  const scale = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.50, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.15, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
    scale.value = withRepeat(
      withSequence(
        withTiming(1.3, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
        withTiming(1.0, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
    return () => {
      cancelAnimation(opacity);
      cancelAnimation(scale);
    };
  }, [opacity, scale]);

  const dotStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.dot, dotStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
});
