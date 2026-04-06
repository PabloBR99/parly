import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useConversationStore } from '../../store/conversationStore';
import type { Message, PersonId } from '../../app/types';

interface Props {
  readonly personId: PersonId;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function HistoryList({ personId }: Props): React.JSX.Element {
  const messages = useConversationStore(s => s.messages);
  const listRef = useRef<FlatList<Message>>(null);

  const doneMessages = useMemo(
    () => messages.filter(m => m.stage === 'done'),
    [messages],
  );

  // Keep newest message visible as items arrive
  useEffect(() => {
    if (doneMessages.length > 0) {
      listRef.current?.scrollToEnd({ animated: doneMessages.length > 1 });
    }
  }, [doneMessages.length]);

  const lastIndex = doneMessages.length - 1;

  const renderItem = useCallback(
    ({ item, index }: { item: Message; index: number }) => {
      const isOtherSpeaker = item.speakerId !== personId;

      // Text in the viewer's language
      const entryText = isOtherSpeaker
        ? (item.translatedText ?? item.originalText)
        : item.originalText;

      // Text in the other language (context line)
      const entryOriginal = isOtherSpeaker
        ? item.originalText
        : (item.translatedText ?? null);

      return (
        <View style={[styles.entry, index === lastIndex && styles.entryLast]}>
          <View style={styles.entryRow}>
            <Text style={styles.timestamp}>{formatTime(item.timestamp)}</Text>
            <Text style={styles.entryText}>{entryText}</Text>
          </View>
          {entryOriginal ? (
            <Text style={styles.entryOriginal} numberOfLines={3}>
              {entryOriginal}
            </Text>
          ) : null}
        </View>
      );
    },
    [personId, lastIndex],
  );

  return (
    <FlatList
      ref={listRef}
      data={doneMessages}
      keyExtractor={item => item.id}
      renderItem={renderItem}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.listContent}
    />
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingVertical: 8,
  },
  entry: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  entryLast: {
    borderBottomWidth: 0,
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 6,
  },
  timestamp: {
    fontFamily: 'Inter-Regular',
    fontSize: 11,
    color: 'rgba(255,255,255,0.20)',
    flexShrink: 0,
    minWidth: 36,
  },
  entryText: {
    fontFamily: 'Inter-Light',
    fontSize: 15,
    lineHeight: 21,
    color: 'rgba(255,255,255,0.75)',
    flex: 1,
  },
  entryOriginal: {
    fontFamily: 'Inter-Regular',
    fontSize: 12,
    color: 'rgba(255,255,255,0.20)',
    marginLeft: 44,
  },
});
