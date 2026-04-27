// StateMorph — a single small glyph that morphs between turn states.
//
// idle         → still dot
// recording    → bars (waveform)
// transcribing → traveling tick (parallel to recording cool-down)
// translating  → rotating ring
// speaking     → expanding waves
// done / error → faded
//
// One unified glyph instead of 5 different ones makes the whole turn feel
// like a continuous gesture rather than a stack of unrelated states.

import React, { useEffect } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import type { TurnStage } from '../../store/conversationStore';
import { color as palette } from '../theme';
import { Waveform } from './Waveform';

interface StateMorphProps {
  readonly stage: TurnStage | null;
  readonly accent: string;
  readonly size?: number;
}

export function StateMorph({
  stage,
  accent,
  size = 22,
}: StateMorphProps): React.JSX.Element {
  switch (stage) {
    case 'recording':
      return <Waveform active color={accent} bars={4} height={size} />;
    case 'transcribing':
      return <Waveform active color={accent} bars={4} height={size} />;
    case 'translating':
      return <Spinner accent={accent} size={size} />;
    case 'speaking':
      return <SpeakingWave accent={accent} size={size} />;
    case 'error':
      return <Dot color={palette.error} size={size * 0.32} />;
    default:
      return <Dot color={palette.fgGhost} size={size * 0.28} />;
  }
}

function Dot({ color, size }: { color: string; size: number }): React.JSX.Element {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
      }}
    />
  );
}

function Spinner({ accent, size }: { accent: string; size: number }): React.JSX.Element {
  const r = useSharedValue(0);
  useEffect(() => {
    r.value = 0;
    r.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(r);
  }, [r]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${r.value * 360}deg` }],
  }));

  const ringStyle: ViewStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    borderWidth: 1.5,
    borderColor: accent,
    borderRightColor: 'transparent',
    borderBottomColor: 'transparent',
  };

  return <Animated.View style={[ringStyle, animatedStyle]} />;
}

function SpeakingWave({ accent, size }: { accent: string; size: number }): React.JSX.Element {
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = 0;
    v.value = withRepeat(
      withTiming(1, { duration: 720, easing: Easing.out(Easing.quad) }),
      -1,
      false,
    );
    return () => cancelAnimation(v);
  }, [v]);

  const inner = useAnimatedStyle(() => ({
    width: size * (0.35 + 0.65 * v.value),
    height: size * (0.35 + 0.65 * v.value),
    borderRadius: (size * (0.35 + 0.65 * v.value)) / 2,
    opacity: 0.7 - 0.7 * v.value,
  }));

  return (
    <View style={[styles.center, { width: size, height: size }]}>
      <View
        style={{
          width: size * 0.32,
          height: size * 0.32,
          borderRadius: (size * 0.32) / 2,
          backgroundColor: accent,
        }}
      />
      <Animated.View
        style={[
          styles.absoluteCenter,
          { borderWidth: 1.4, borderColor: accent },
          inner,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  absoluteCenter: { position: 'absolute' },
});
