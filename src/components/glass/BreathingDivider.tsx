import React, { useEffect, useRef } from 'react';
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
import type { SharedValue } from 'react-native-reanimated';
import { useAudioLevelStore } from '../../store/audioLevelStore';
import type { PipelineStage } from '../../app/types';

interface Props {
  readonly pipelineStage: PipelineStage;
}

function startBreathing(
  opacity: SharedValue<number>,
  scaleX: SharedValue<number>,
  stage: PipelineStage,
): void {
  cancelAnimation(opacity);
  cancelAnimation(scaleX);

  if (stage === 'idle' || stage === 'listening') {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.5, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.15, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
    scaleX.value = withRepeat(
      withSequence(
        withTiming(1.0, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.6, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
  } else if (stage === 'recording') {
    // Fast bright pulse during PTT recording
    opacity.value = withRepeat(
      withSequence(
        withTiming(1.0, { duration: 200, easing: Easing.out(Easing.ease) }),
        withTiming(0.4, { duration: 300, easing: Easing.in(Easing.ease) }),
      ),
      -1,
      false,
    );
    scaleX.value = withTiming(1.0, { duration: 200 });
  } else {
    // Processing (transcribing / translating / synthesizing / playing) — steady glow
    opacity.value = withTiming(0.7, { duration: 200 });
    scaleX.value = withTiming(0.8, { duration: 200 });
  }
}

export function BreathingDivider({ pipelineStage }: Props): React.JSX.Element {
  const opacity = useSharedValue(0.15);
  const scaleX = useSharedValue(0.6);
  const audioLevel = useAudioLevelStore(s => s.level);
  const isReactive = useRef(false);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // React to audio level in real time
  useEffect(() => {
    const REACTIVE_THRESHOLD = 0.05;
    const SILENCE_DEBOUNCE_MS = 300;

    if (audioLevel > REACTIVE_THRESHOLD) {
      // Clear any pending return-to-idle timer
      if (silenceTimer.current) {
        clearTimeout(silenceTimer.current);
        silenceTimer.current = null;
      }

      if (!isReactive.current) {
        isReactive.current = true;
        cancelAnimation(opacity);
        cancelAnimation(scaleX);
      }

      // Map level directly to visual properties — no easing, instant response
      opacity.value = 0.15 + audioLevel * 0.85;
      scaleX.value = 0.6 + audioLevel * 0.4;
    } else if (isReactive.current && !silenceTimer.current) {
      // Level dropped — debounce before returning to idle breathing
      silenceTimer.current = setTimeout(() => {
        silenceTimer.current = null;
        isReactive.current = false;
        startBreathing(opacity, scaleX, pipelineStage);
      }, SILENCE_DEBOUNCE_MS);
    }
  }, [audioLevel, opacity, scaleX, pipelineStage]);

  // Restart breathing whenever pipeline stage changes (if not mid-speech)
  useEffect(() => {
    if (!isReactive.current) {
      startBreathing(opacity, scaleX, pipelineStage);
    }
    // opacity/scaleX are stable shared values — intentionally omitted from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineStage]);

  const lineStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scaleX: scaleX.value }],
  }));

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.line, lineStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  line: {
    height: 1,
    backgroundColor: '#ffffff',
  },
});
