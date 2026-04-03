import React, { useEffect, useRef } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import type { Message, PersonId } from '../../app/types';
import { ChatBubble } from './ChatBubble';

interface Props {
  readonly messages: readonly Message[];
  readonly viewerPersonId: PersonId;
  readonly lang: string;
}

export function ChatBubbleList({ messages, viewerPersonId, lang }: Props): React.JSX.Element {
  const listRef = useRef<FlatList<Message>>(null);

  // Only show messages relevant to this panel:
  // - Messages this person sent (shows original text)
  // - Messages sent TO this person (shows translated text, only when ready)
  const visibleMessages = messages.filter(m => {
    if (m.speakerId === viewerPersonId) return true;
    return m.translatedText !== null || m.stage === 'translating';
  });

  useEffect(() => {
    if (visibleMessages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [visibleMessages.length]);

  return (
    <FlatList
      ref={listRef}
      data={visibleMessages as Message[]}
      keyExtractor={item => item.id}
      renderItem={({ item }) => (
        <ChatBubble message={item} viewerPersonId={viewerPersonId} lang={lang} />
      )}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 8,
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
});
