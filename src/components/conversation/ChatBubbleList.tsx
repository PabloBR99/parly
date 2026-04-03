import React, { useEffect, useMemo, useRef } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import type { Message, PersonId } from '../../app/types';
import { ChatBubble } from './ChatBubble';

interface Props {
  readonly messages: readonly Message[];
  readonly viewerPersonId: PersonId;
  readonly lang: string;
  readonly inverted?: boolean;
}

export function ChatBubbleList({ messages, viewerPersonId, lang, inverted }: Props): React.JSX.Element {
  const listRef = useRef<FlatList<Message>>(null);

  // Only show messages relevant to this panel:
  // - Messages this person sent (shows original text)
  // - Messages sent TO this person (shows translated text, only when ready)
  const visibleMessages = useMemo(
    () => messages.filter(m => {
      if (m.speakerId === viewerPersonId) return true;
      // Show other person's messages when translated, translating, or failed
      return m.translatedText !== null || m.stage === 'translating' || m.stage === 'error';
    }),
    [messages, viewerPersonId],
  );

  useEffect(() => {
    if (visibleMessages.length > 0 && !inverted) {
      listRef.current?.scrollToEnd({ animated: true });
    }
    // When inverted, FlatList auto-shows newest items at the top (visually bottom
    // of the rotated panel), so no manual scroll needed.
  }, [visibleMessages.length, inverted]);

  return (
    <FlatList
      ref={listRef}
      data={visibleMessages as Message[]}
      keyExtractor={item => item.id}
      renderItem={({ item }) => (
        <ChatBubble message={item} viewerPersonId={viewerPersonId} lang={lang} />
      )}
      inverted={inverted}
      contentContainerStyle={inverted ? styles.contentInverted : styles.content}
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
  contentInverted: {
    paddingVertical: 8,
  },
});
