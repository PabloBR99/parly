import React from 'react';
import { StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import type { Message, PersonId } from '../../app/types';
import { getUiStrings } from '../../i18n/uiStrings';

interface Props {
  readonly message: Message;
  readonly viewerPersonId: PersonId;
  readonly lang: string;
}

export const ChatBubble = React.memo(function ChatBubble({ message, viewerPersonId, lang }: Props): React.JSX.Element {
  const s = getUiStrings(lang);
  const isOwnMessage = message.speakerId === viewerPersonId;
  const isPending = message.stage === 'transcribing' || message.stage === 'translating';
  const isError = message.stage === 'error';

  // Each panel always shows text in the viewer's language:
  // - Own messages: originalText (spoken in viewer's language)
  // - Other's messages: translatedText (translated into viewer's language)
  // - Error on other's message: localized error string (never show source-language text)
  let displayText: string;
  if (isOwnMessage) {
    displayText = message.originalText;
  } else if (message.translatedText) {
    displayText = message.translatedText;
  } else if (isError) {
    displayText = s.translationFailed;
  } else {
    displayText = '';
  }

  return (
    <View style={[styles.row, isOwnMessage ? styles.rowRight : styles.rowLeft]}>
      <View style={[
        styles.bubble,
        isOwnMessage ? styles.ownBubble : styles.otherBubble,
        isError && styles.errorBubble,
      ]}>
        {isPending ? (
          <View style={styles.pendingRow}>
            <ActivityIndicator size="small" color="#9ca3af" />
            <Text style={[styles.text, styles.pendingText]}>
              {message.stage === 'transcribing' ? s.transcribing : s.translating}
            </Text>
          </View>
        ) : (
          <Text style={styles.text}>{displayText}</Text>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    marginVertical: 4,
    marginHorizontal: 12,
  },
  rowRight: {
    alignItems: 'flex-end',
  },
  rowLeft: {
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  ownBubble: {
    backgroundColor: '#2563eb',
    borderBottomRightRadius: 4,
  },
  otherBubble: {
    backgroundColor: '#1f2937',
    borderBottomLeftRadius: 4,
  },
  errorBubble: {
    backgroundColor: '#7f1d1d',
    borderColor: '#dc2626',
    borderWidth: 1,
  },
  text: {
    color: '#f9fafb',
    fontSize: 16,
    lineHeight: 22,
  },
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pendingText: {
    color: '#9ca3af',
    fontSize: 14,
  },
});
