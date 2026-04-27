// Waveform — a row of bars whose heights breathe in a phase-shifted sine
// while the speaker is recording. Pure visual cue; not driven by mic level
// because the audio capture path doesn't surface live RMS, and approximating
// it from native callbacks would add render churn for a marginal payoff.
//
// We instead encode INTENT: "the mic is open, your voice is being captured."
// The phase shift between bars makes it feel alive without mocking volume.

import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';

interface WaveformProps {
  readonly active: boolean;
  readonly color: string;
  readonly bars?: number;
  readonly height?: number;
}

export function Waveform({
  active,
  color,
  bars = 5,
  height = 24,
}: WaveformProps): React.JSX.Element {
  return (
    <View style={[styles.row, { height }]}>
      {Array.from({ length: bars }).map((_, i) => (
        <Bar
          key={i}
          index={i}
          total={bars}
          active={active}
          color={color}
          maxHeight={height}
        />
      ))}
    </View>
  );
}

interface BarProps {
  readonly index: number;
  readonly total: number;
  readonly active: boolean;
  readonly color: string;
  readonly maxHeight: number;
}

function Bar({ index, total, active, color, maxHeight }: BarProps): React.JSX.Element {
  const v = useSharedValue(0);

  useEffect(() => {
    if (active) {
      // Stagger phase so adjacent bars don't pulse in unison.
      const phaseOffsetMs = (index / total) * 280;
      v.value = withTiming(0, { duration: phaseOffsetMs });
      v.value = withRepeat(
        withTiming(1, { duration: 520 + (index % 3) * 90, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      );
    } else {
      cancelAnimation(v);
      v.value = withTiming(0, { duration: 200 });
    }
    return () => cancelAnimation(v);
  }, [active, index, total, v]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: maxHeight * (0.18 + 0.82 * v.value),
    opacity: 0.55 + 0.45 * v.value,
  }));

  return (
    <Animated.View
      style={[
        styles.bar,
        { backgroundColor: color },
        animatedStyle,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bar: {
    width: 3,
    marginHorizontal: 2,
    borderRadius: 2,
  },
});
