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
import type { PersonId, PipelineStage } from '../../app/types';

interface Props {
  readonly activeSpeaker: PersonId | null;
  readonly pipelineStage: PipelineStage;
  readonly onLongPress?: () => void;
}

export function BreathingDivider({
  activeSpeaker,
  pipelineStage,
  onLongPress,
}: Props): React.JSX.Element {
  const opacity = useSharedValue(0.08);

  useEffect(() => {
    cancelAnimation(opacity);

    if (pipelineStage === 'idle' || pipelineStage === 'listening') {
      // Idle — gentle breathing
      opacity.value = withRepeat(
        withSequence(
          withTiming(0.5, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.15, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      );
    } else if (pipelineStage === 'recording') {
      // Recording — fast bright pulse so the user sees speech was detected
      opacity.value = withRepeat(
        withSequence(
          withTiming(1.0, { duration: 200, easing: Easing.out(Easing.ease) }),
          withTiming(0.4, { duration: 300, easing: Easing.in(Easing.ease) }),
        ),
        -1,
        false,
      );
    } else {
      // Processing (transcribing / translating / synthesizing / playing) — steady bright
      opacity.value = withTiming(0.7, { duration: 200 });
    }
  }, [pipelineStage, activeSpeaker, opacity]);

  const lineStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <View
      style={styles.container}
      onTouchEnd={undefined}
      // Long press handled via Pressable wrapper in parent
    >
      <Animated.View style={[styles.line, lineStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
  },
  line: {
    height: 1,
    backgroundColor: '#ffffff',
  },
});
