import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

interface Props {
  /** The main (large) text to display — either a translation or own speech. */
  readonly mainText: string;
  /** Small gray original text shown below the main text (when displaying a translation). */
  readonly originalText?: string;
  /** Ghost text from the previous exchange — shown above, very faint. */
  readonly ghostText?: string;
}

/**
 * Subtitle-style text display. Shows the latest utterance large and centered,
 * with an optional ghost of the previous message and the original text below.
 *
 * Each new `mainText` fades in smoothly.
 */
export function SubtitleView({ mainText, originalText, ghostText }: Props): React.JSX.Element {
  // Track the previous mainText to trigger fade-in on change
  const prevMain = useRef(mainText);
  const mainOpacity = useSharedValue(1);
  const mainTranslateY = useSharedValue(0);

  useEffect(() => {
    if (mainText !== prevMain.current) {
      prevMain.current = mainText;
      // Reset and animate in
      mainOpacity.value = 0;
      mainTranslateY.value = 8;
      mainOpacity.value = withTiming(1, { duration: 500, easing: Easing.out(Easing.ease) });
      mainTranslateY.value = withTiming(0, { duration: 500, easing: Easing.out(Easing.ease) });
    }
  }, [mainText, mainOpacity, mainTranslateY]);

  const mainStyle = useAnimatedStyle(() => ({
    opacity: mainOpacity.value,
    transform: [{ translateY: mainTranslateY.value }],
  }));

  return (
    <View style={styles.container}>
      {ghostText ? (
        <Animated.Text
          style={styles.ghost}
          entering={FadeIn.duration(400)}
          numberOfLines={2}
        >
          {ghostText}
        </Animated.Text>
      ) : null}

      <Animated.Text style={[styles.main, mainStyle]} numberOfLines={4}>
        {mainText}
      </Animated.Text>

      {originalText ? (
        <Animated.Text
          style={styles.original}
          entering={FadeIn.duration(400).delay(200)}
          numberOfLines={2}
        >
          {originalText}
        </Animated.Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 8,
  },
  ghost: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.15)',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 8,
  },
  main: {
    fontSize: 22,
    fontWeight: '400',
    color: 'rgba(255,255,255,0.92)',
    textAlign: 'center',
    lineHeight: 30,
  },
  original: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.25)',
    textAlign: 'center',
    lineHeight: 18,
    marginTop: 4,
  },
});
