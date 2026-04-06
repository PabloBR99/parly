import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import type { ModelStatus } from '../../app/types';

interface Props {
  readonly status: ModelStatus;
  readonly progress: number; // 0–100
}

/**
 * Minimal loading screen — pure black, single breathing dot, one-line status.
 * The dot IS the app. 5px white, opacity 0.15→0.50, pulsing like a heartbeat.
 */
export function GlassLoadingOverlay({ status, progress }: Props): React.JSX.Element {
  const opacity = useSharedValue(0.15);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.50, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.15, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
  }, [opacity]);

  const dotStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const statusText = statusLabel(status, progress);

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.dot, dotStyle]} />

      <Text style={styles.label}>{statusText}</Text>

      {status === 'downloading' && progress > 0 ? (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress}%` }]} />
        </View>
      ) : null}
    </View>
  );
}

function statusLabel(status: ModelStatus, progress: number): string {
  switch (status) {
    case 'not_downloaded': return 'Preparando\u2026';
    case 'downloading': return progress > 0 ? `${Math.round(progress)}%` : 'Descargando\u2026';
    case 'loading': return 'Cargando\u2026';
    case 'error': return 'Error';
    default: return '';
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#ffffff',
  },
  label: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.25)',
    letterSpacing: 0.5,
  },
  progressTrack: {
    width: 80,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 1,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 1,
  },
});
