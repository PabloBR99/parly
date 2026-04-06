import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { getLanguage } from '../../app/languages';

interface Props {
  readonly lang: string;
  readonly timestamp: number;
}

/**
 * Subtle toast: "Español detectado" — fades in, holds 2s, fades out.
 * Re-triggers when timestamp changes.
 */
export function LanguageToast({ lang, timestamp }: Props): React.JSX.Element {
  const opacity = useSharedValue(0);

  useEffect(() => {
    if (!timestamp) return;
    // fade in → hold → fade out
    opacity.value = withSequence(
      withTiming(1, { duration: 600, easing: Easing.out(Easing.ease) }),
      withDelay(2000, withTiming(0, { duration: 800, easing: Easing.in(Easing.ease) })),
    );
  }, [timestamp, opacity]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const language = getLanguage(lang);
  const label = `${language.name} detectado`;

  return (
    <Animated.Text style={[styles.text, style]}>
      {label}
    </Animated.Text>
  );
}

const styles = StyleSheet.create({
  text: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.28)',
    textAlign: 'center',
    letterSpacing: 0.5,
    marginTop: 12,
  },
});
