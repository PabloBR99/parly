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
 * Minimal loading screen for the Glass UI.
 * Black background, single breathing orb, subtle progress ring, one-line status.
 */
export function GlassLoadingOverlay({ status, progress }: Props): React.JSX.Element {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(0.25);

  useEffect(() => {
    scale.value = withRepeat(
      withSequence(
        withTiming(1.08, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
        withTiming(1.0, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.6, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.25, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
  }, [scale, opacity]);

  const orbStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const statusText = statusLabel(status, progress);

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.ring, orbStyle]}>
        <View style={styles.dot} />
      </Animated.View>

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
    case 'not_downloaded': return 'Preparando…';
    case 'downloading': return progress > 0 ? `${Math.round(progress)}%` : 'Descargando…';
    case 'loading': return 'Cargando…';
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
  ring: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.3)',
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
