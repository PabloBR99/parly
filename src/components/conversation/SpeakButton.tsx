import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withRepeat,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import type { PipelineStage } from '../../app/types';
import { getUiStrings } from '../../i18n/uiStrings';

interface Props {
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
  readonly pipelineStage: PipelineStage;
  readonly disabled?: boolean;
  readonly lang: string;
}

export function SpeakButton({
  onPressIn,
  onPressOut,
  pipelineStage,
  disabled = false,
  lang,
}: Props): React.JSX.Element {
  const s = getUiStrings(lang);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const isRecording = pipelineStage === 'recording';
  const isBusy =
    pipelineStage === 'transcribing' ||
    pipelineStage === 'translating' ||
    pipelineStage === 'synthesizing' ||
    pipelineStage === 'playing';

  const handlePressIn = useCallback(() => {
    if (disabled || isBusy) return;
    scale.value = withSpring(0.92);
    opacity.value = withRepeat(withTiming(0.6, { duration: 700 }), -1, true);
    onPressIn();
  }, [disabled, isBusy, onPressIn, scale, opacity]);

  const handlePressOut = useCallback(() => {
    if (disabled || isBusy) return;
    scale.value = withSpring(1);
    cancelAnimation(opacity);
    opacity.value = withTiming(1);
    onPressOut();
  }, [disabled, isBusy, onPressOut, scale, opacity]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const label = isRecording
    ? s.recording
    : isBusy
    ? stageLabel(pipelineStage, s)
    : s.holdToSpeak;

  return (
    <View style={styles.container}>
      <Animated.View style={animStyle}>
        <Pressable
          style={[
            styles.button,
            isRecording && styles.buttonRecording,
            isBusy && styles.buttonBusy,
            disabled && styles.buttonDisabled,
          ]}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          disabled={disabled || isBusy}>
          <Text style={styles.icon}>{isRecording ? '🎙️' : isBusy ? '⚙️' : '🎤'}</Text>
        </Pressable>
      </Animated.View>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

function stageLabel(stage: PipelineStage, s: ReturnType<typeof getUiStrings>): string {
  switch (stage) {
    case 'transcribing': return s.transcribing;
    case 'translating':  return s.translating;
    case 'synthesizing': return s.synthesizing;
    case 'playing':      return s.playing;
    default: return '';
  }
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 16,
    gap: 8,
  },
  button: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#2563eb',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 8,
  },
  buttonRecording: {
    backgroundColor: '#dc2626',
    shadowColor: '#dc2626',
  },
  buttonBusy: {
    backgroundColor: '#374151',
    shadowOpacity: 0,
  },
  buttonDisabled: {
    backgroundColor: '#1f2937',
    shadowOpacity: 0,
  },
  icon: { fontSize: 28 },
  label: {
    fontSize: 12,
    color: '#6b7280',
    textAlign: 'center',
  },
});
