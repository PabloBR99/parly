import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { getUiStrings } from '../../i18n/uiStrings';
import type { PipelineStage } from '../../app/types';

interface Props {
  readonly stage: PipelineStage;
  readonly lang: string;
}

export function StatusIndicator({ stage, lang }: Props): React.JSX.Element {
  const s = getUiStrings(lang);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(0.4);

  useEffect(() => {
    cancelAnimation(scale);
    cancelAnimation(opacity);

    if (stage === 'listening') {
      scale.value = withRepeat(
        withSequence(
          withTiming(1.5, { duration: 900, easing: Easing.out(Easing.ease) }),
          withTiming(1.0, { duration: 900, easing: Easing.in(Easing.ease) }),
        ),
        -1,
        false,
      );
      opacity.value = withRepeat(
        withSequence(withTiming(1, { duration: 900 }), withTiming(0.4, { duration: 900 })),
        -1,
        false,
      );
    } else if (stage === 'recording') {
      scale.value = withRepeat(withTiming(1.15, { duration: 350 }), -1, true);
      opacity.value = withTiming(1, { duration: 150 });
    } else if (stage !== 'idle') {
      scale.value = withRepeat(
        withSequence(
          withTiming(1.2, { duration: 500, easing: Easing.inOut(Easing.ease) }),
          withTiming(1.0, { duration: 500, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      );
      opacity.value = withTiming(0.85, { duration: 200 });
    } else {
      scale.value = withTiming(1, { duration: 300 });
      opacity.value = withTiming(0.25, { duration: 300 });
    }
  }, [stage, scale, opacity]);

  const dotAnim = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const color = DOT_COLORS[stage] ?? '#374151';
  const label = stageLabel(stage, s);

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.dot, { backgroundColor: color }, dotAnim]} />
      {label ? <Text style={styles.label}>{label}</Text> : null}
    </View>
  );
}

const DOT_COLORS: Record<PipelineStage, string> = {
  idle:         '#374151',
  listening:    '#22c55e',
  recording:    '#dc2626',
  transcribing: '#f59e0b',
  translating:  '#3b82f6',
  synthesizing: '#8b5cf6',
  playing:      '#8b5cf6',
};

function stageLabel(stage: PipelineStage, s: ReturnType<typeof getUiStrings>): string {
  switch (stage) {
    case 'listening':    return s.listening;
    case 'recording':    return s.recording;
    case 'transcribing': return s.transcribing;
    case 'translating':  return s.translating;
    case 'synthesizing': return s.synthesizing;
    case 'playing':      return s.playing;
    default:             return '';
  }
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 14,
    gap: 8,
    minHeight: 56,
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  label: {
    fontSize: 12,
    color: '#6b7280',
    textAlign: 'center',
  },
});
