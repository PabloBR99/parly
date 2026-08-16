// Waveform — a row of bars whose heights breathe in a phase-shifted sine
// while the speaker is recording. Pure visual cue: it encodes INTENT ("the mic
// is open, your voice is being captured"), not volume.
//
// Why not the live level, when SeamControl has it? Hands-free already decodes
// every capture chunk to PCM to feed the VAD, so its meter is free (see
// services/audio/audioLevelBus). Push-to-talk forwards base64 straight to
// Voxtral and never touches the samples — metering it would mean adding a
// decode + RMS pass to the PTT hot path for a bar that is already saying the
// one thing it needs to say. The person holding the disc knows they're talking.

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

  // scaleY, never height: animating height re-layouts every bar every frame
  // exactly while the JS thread is busiest (audio chunks, base64 decode,
  // store writes per partial). A transform stays on the UI thread —
  // rock-solid on Android, same visual (bars are center-aligned, so both
  // grow from the middle). Same approach as SeamControl.
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: 0.18 + 0.82 * v.value }],
    opacity: 0.55 + 0.45 * v.value,
  }));

  return (
    <Animated.View
      style={[
        styles.bar,
        { backgroundColor: color, height: maxHeight },
        animatedStyle,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  bar: { width: 3, marginHorizontal: 2, borderRadius: 2 },
});
