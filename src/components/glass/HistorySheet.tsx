import React, { useCallback, useEffect, useRef } from 'react';
import {
  Dimensions,
  FlatList,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useConversationStore } from '../../store/conversationStore';
import { useSettingsStore } from '../../store/settingsStore';
import type { Message } from '../../app/types';

const SCREEN_HEIGHT = Dimensions.get('window').height;

interface Props {
  readonly visible: boolean;
  readonly onClose: () => void;
}

export function HistorySheet({ visible, onClose }: Props): React.JSX.Element {
  const translateY = useSharedValue(SCREEN_HEIGHT);
  const messages = useConversationStore(s => s.messages);
  const personA = useSettingsStore(s => s.personA);
  const personB = useSettingsStore(s => s.personB);

  useEffect(() => {
    translateY.value = withTiming(visible ? 0 : SCREEN_HEIGHT, {
      duration: 380,
      easing: Easing.out(Easing.cubic),
    });
  }, [visible, translateY]);

  const startY = useRef(0);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) => gs.dy > 8,
      onPanResponderGrant: (_, gs) => {
        startY.current = gs.y0;
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > 60) {
          onClose();
        }
      },
    }),
  ).current;

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const doneMessages = messages.filter(m => m.stage === 'done');

  const renderItem = useCallback(
    ({ item }: { item: Message }) => {
      const isA = item.speakerId === 'person_a';

      return (
        <View style={[styles.card, isA ? styles.cardA : styles.cardB]}>
          <Text style={styles.cardMain} numberOfLines={3}>
            {item.translatedText ?? item.originalText}
          </Text>
          <Text style={styles.cardOriginal} numberOfLines={2}>
            {item.originalText}
          </Text>
          <View style={styles.cardLangDot}>
            <Text style={styles.cardLangText}>
              {isA ? personA.language.toUpperCase() : personB.language.toUpperCase()}
            </Text>
          </View>
        </View>
      );
    },
    [personA, personB],
  );

  return (
    <Animated.View style={[styles.sheet, sheetStyle]}>
      {/* Drag handle */}
      <View {...panResponder.panHandlers} style={styles.handleArea}>
        <View style={styles.handle} />
      </View>

      <FlatList
        data={[...doneMessages].reverse()}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        inverted
      />

      <Pressable style={styles.closeBtn} onPress={onClose}>
        <Text style={styles.closeText}>Cerrar</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000000',
    zIndex: 100,
  },
  handleArea: {
    paddingTop: 20,
    paddingBottom: 12,
    alignItems: 'center',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 80,
  },
  card: {
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    backgroundColor: 'rgba(255,255,255,0.04)',
    position: 'relative',
  },
  cardA: {
    // Bottom person — no extra style
  },
  cardB: {
    // Top person — slightly different shade to distinguish
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  cardMain: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.5)',
    lineHeight: 20,
    marginBottom: 4,
  },
  cardOriginal: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.2)',
    lineHeight: 15,
  },
  cardLangDot: {
    position: 'absolute',
    top: 10,
    right: 12,
  },
  cardLangText: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.12)',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  closeBtn: {
    position: 'absolute',
    bottom: 32,
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 24,
  },
  closeText: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.25)',
    letterSpacing: 0.5,
  },
});
