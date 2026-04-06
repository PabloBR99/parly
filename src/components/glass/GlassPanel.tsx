import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useConversationStore } from '../../store/conversationStore';
import type { PersonId } from '../../app/types';
import { SubtitleView } from './SubtitleView';
import { LanguageToast } from './LanguageToast';

interface Props {
  readonly personId: PersonId;
}

export function GlassPanel({ personId }: Props): React.JSX.Element {
  const detectedLangs = useConversationStore(s => s.detectedLangs);
  const detection = detectedLangs[personId];

  return (
    <View style={styles.container}>
      <SubtitleView personId={personId} />

      {detection ? (
        <View style={styles.toast} pointerEvents="none">
          <LanguageToast lang={detection.lang} timestamp={detection.timestamp} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  toast: {
    position: 'absolute',
    bottom: 16,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
});
