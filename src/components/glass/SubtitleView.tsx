import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useConversationStore } from '../../store/conversationStore';
import type { StreamingPartial } from '../../store/conversationStore';
import type { PersonId } from '../../app/types';
import { HistoryList } from './HistoryList';

interface Props {
  readonly personId: PersonId;
}

/**
 * Derives the subtitle text to display for this person's half.
 * Incorporates streaming partials — shows real-time transcription/translation
 * from the other person while they're speaking.
 */
function useSubtitleContent(personId: PersonId) {
  const messages = useConversationStore(s => s.messages);
  const streamingPartial = useConversationStore(s => s.streamingPartial);

  return useMemo(() => {
    // Streaming partial from the OTHER person → show live translation to this viewer
    const partial: StreamingPartial | null =
      streamingPartial && streamingPartial.speakerId !== personId
        ? streamingPartial
        : null;

    // Completed translations FROM the other person
    const received = messages.filter(
      m => m.speakerId !== personId && m.stage === 'done',
    );
    const latestReceived = received.at(-1);
    const prevReceived = received.at(-2);

    // Viewer's own utterances
    const ownMessages = messages.filter(m => m.speakerId === personId);
    const latestOwn = ownMessages.at(-1);

    // Streaming partial takes priority — show live translation
    if (partial) {
      const mainText = partial.translation || partial.transcript;
      return {
        mainText,
        originalText: partial.translation ? partial.transcript : null,
        ghostText: latestReceived?.translatedText ?? null,
        isStreaming: true,
      };
    }

    if (latestReceived) {
      return {
        mainText: latestReceived.translatedText ?? latestReceived.originalText,
        originalText: latestReceived.originalText,
        ghostText: prevReceived?.translatedText ?? null,
        isStreaming: false,
      };
    }
    if (latestOwn) {
      return { mainText: latestOwn.originalText, originalText: null, ghostText: null, isStreaming: false };
    }
    return { mainText: null, originalText: null, ghostText: null, isStreaming: false };
  }, [messages, personId, streamingPartial]);
}

/**
 * One person's half content area.
 *
 * Pinch outward → toggle history on/off
 * Pinch OUT (scale > 1.5) → open history
 * Pinch IN  (scale < 0.7) → close history
 *
 * Font files required in android/app/src/main/assets/fonts/:
 *   Inter-Light.ttf, Inter-Regular.ttf
 */
export function SubtitleView({ personId }: Props): React.JSX.Element {
  const [showHistory, setShowHistory] = useState(false);

  const messages = useConversationStore(s => s.messages);
  const doneMessages = useMemo(
    () => messages.filter(m => m.stage === 'done'),
    [messages],
  );

  const { mainText, originalText, ghostText, isStreaming } = useSubtitleContent(personId);

  // --- Shared values (UI-thread safe) ---
  const pinchScale = useSharedValue(1);
  const isHistoryOpen = useSharedValue(false); // mirrors showHistory for worklets
  const hasMessages = useSharedValue(doneMessages.length > 0);

  useEffect(() => {
    hasMessages.value = doneMessages.length > 0;
  }, [doneMessages.length, hasMessages]);

  // --- Cross-fade animation values ---
  const subtitleOpacity = useSharedValue(1);
  const historyOpacity = useSharedValue(0);
  const historyTranslateY = useSharedValue(20);

  const openHistory = useCallback(() => {
    isHistoryOpen.value = true;
    setShowHistory(true);
  }, [isHistoryOpen]);

  const closeHistory = useCallback(() => {
    isHistoryOpen.value = false;
    setShowHistory(false);
  }, [isHistoryOpen]);

  useEffect(() => {
    if (showHistory) {
      subtitleOpacity.value = withTiming(0, { duration: 200 });
      historyOpacity.value = withTiming(1, { duration: 300 });
      historyTranslateY.value = withTiming(0, {
        duration: 300,
        easing: Easing.out(Easing.ease),
      });
    } else {
      historyOpacity.value = withTiming(0, { duration: 200 });
      subtitleOpacity.value = withTiming(1, { duration: 300 });
      historyTranslateY.value = withTiming(20, { duration: 200 });
    }
  }, [showHistory, subtitleOpacity, historyOpacity, historyTranslateY]);

  // --- Pinch gesture ---
  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      pinchScale.value = e.scale;
    })
    .onEnd((e) => {
      if (!isHistoryOpen.value && e.scale > 1.5 && hasMessages.value) {
        pinchScale.value = withTiming(1, { duration: 200 });
        runOnJS(openHistory)();
      } else if (isHistoryOpen.value && e.scale < 0.7) {
        pinchScale.value = withTiming(1, { duration: 200 });
        runOnJS(closeHistory)();
      } else {
        // Didn't cross threshold — snap back
        pinchScale.value = withTiming(1, { duration: 200 });
      }
    });

  // --- Animated styles ---

  // Subtitle layer: scales with pinch + fades with opacity animation
  // While pinching out (scale 1→1.5), opacity drops from 1→0.6 as visual hint
  const subtitleAnimStyle = useAnimatedStyle(() => {
    const s = pinchScale.value;
    // Manual linear interpolation: scale 1→1.5 maps to opacity 1→0.6
    const pinchOpacity = s <= 1 ? 1 : Math.max(0.6, 1 - ((s - 1) / 0.5) * 0.4);
    return {
      opacity: subtitleOpacity.value * pinchOpacity,
      transform: [{ scale: s }],
    };
  });

  const historyAnimStyle = useAnimatedStyle(() => ({
    opacity: historyOpacity.value,
    transform: [{ translateY: historyTranslateY.value }],
  }));

  // --- Text-change animation for the main subtitle text ---
  const prevMain = useRef(mainText);
  const mainOpacity = useSharedValue(1);
  const mainTranslateY = useSharedValue(0);

  useEffect(() => {
    if (mainText !== prevMain.current) {
      prevMain.current = mainText;
      // Skip entrance animation during streaming — updates are too rapid
      if (!isStreaming) {
        mainOpacity.value = 0;
        mainTranslateY.value = 12;
        mainOpacity.value = withTiming(1, { duration: 400, easing: Easing.out(Easing.ease) });
        mainTranslateY.value = withTiming(0, { duration: 400, easing: Easing.out(Easing.ease) });
      }
    }
  }, [mainText, mainOpacity, mainTranslateY, isStreaming]);

  const mainTextAnimStyle = useAnimatedStyle(() => ({
    opacity: mainOpacity.value,
    transform: [{ translateY: mainTranslateY.value }],
  }));

  return (
    <GestureDetector gesture={pinchGesture}>
      <Animated.View style={styles.fill}>

        {/* ── Subtitle layer ── */}
        <Animated.View style={[styles.layer, styles.subtitleCenter, subtitleAnimStyle]}>
          {mainText !== null ? (
            <Animated.View style={styles.subtitleContent}>
              {ghostText ? (
                <Animated.Text style={styles.ghost} numberOfLines={2}>
                  {ghostText}
                </Animated.Text>
              ) : null}

              <Animated.Text
                style={[
                  styles.main,
                  mainTextAnimStyle,
                  isStreaming && styles.streaming,
                ]}
                numberOfLines={4}
              >
                {mainText}
              </Animated.Text>

              {originalText ? (
                <Animated.Text style={styles.original} numberOfLines={2}>
                  {originalText}
                </Animated.Text>
              ) : null}
            </Animated.View>
          ) : null}
        </Animated.View>

        {/* ── History layer — always mounted so FlatList keeps its scroll position ── */}
        <Animated.View style={[styles.layer, historyAnimStyle]}>
          <HistoryList personId={personId} />
        </Animated.View>

      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  layer: {
    ...StyleSheet.absoluteFillObject,
  },
  subtitleCenter: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  subtitleContent: {
    alignItems: 'center',
  },
  ghost: {
    fontFamily: 'Inter-Light',
    fontSize: 14,
    color: 'rgba(255,255,255,0.10)',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  main: {
    fontFamily: 'Inter-Light',
    fontSize: 22,
    color: 'rgba(255,255,255,0.92)',
    textAlign: 'center',
    lineHeight: 30,
    letterSpacing: -0.3,
  },
  streaming: {
    color: 'rgba(255,255,255,0.60)',
    fontStyle: 'italic',
  },
  original: {
    fontFamily: 'Inter-Regular',
    fontSize: 13,
    color: 'rgba(255,255,255,0.25)',
    textAlign: 'center',
    lineHeight: 18,
    marginTop: 8,
  },
});
