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

const BAR_COUNT = 5;
const BAR_CONFIGS = [
  { max: 18, duration: 600, delay: 0 },
  { max: 24, duration: 500, delay: 100 },
  { max: 14, duration: 550, delay: 50 },
  { max: 24, duration: 500, delay: 150 },
  { max: 18, duration: 600, delay: 200 },
];

function WaveBar({ config }: { config: typeof BAR_CONFIGS[number] }): React.JSX.Element {
  const height = useSharedValue(4);

  useEffect(() => {
    // Small initial delay via setTimeout to stagger the bars
    const timeout = setTimeout(() => {
      height.value = withRepeat(
        withTiming(config.max, {
          duration: config.duration,
          easing: Easing.inOut(Easing.ease),
        }),
        -1,
        true,
      );
    }, config.delay);

    return () => {
      clearTimeout(timeout);
      cancelAnimation(height);
    };
  }, [height, config]);

  const style = useAnimatedStyle(() => ({
    height: height.value,
  }));

  return <Animated.View style={[styles.bar, style]} />;
}

export function WaveformIndicator(): React.JSX.Element {
  return (
    <View style={styles.container}>
      {BAR_CONFIGS.map((config, i) => (
        <WaveBar key={i} config={config} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    height: 28,
  },
  bar: {
    width: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(255,255,255,0.4)',
  },
});
