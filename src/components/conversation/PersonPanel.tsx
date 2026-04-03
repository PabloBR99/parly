import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useConversationStore } from '../../store/conversationStore';
import { useSettingsStore } from '../../store/settingsStore';
import { audioCaptureService } from '../../services/audio/AudioCaptureService';
import { pipelineOrchestrator } from '../../services/pipeline/PipelineOrchestrator';
import type { PersonId } from '../../app/types';
import { ChatBubbleList } from './ChatBubbleList';
import { LanguageSelector } from './LanguageSelector';
import { SpeakButton } from './SpeakButton';
import { StatusIndicator } from './StatusIndicator';

interface Props {
  readonly personId: PersonId;
  readonly inverted?: boolean;
}

export function PersonPanel({ personId, inverted }: Props): React.JSX.Element {
  const messages = useConversationStore(s => s.messages);
  const activeSpeaker = useConversationStore(s => s.activeSpeaker);
  const pipelineStage = useConversationStore(s => s.pipelineStage);
  const setActiveSpeaker = useConversationStore(s => s.setActiveSpeaker);

  const language = useSettingsStore(s =>
    personId === 'person_a' ? s.personA.language : s.personB.language,
  );
  const setPersonLanguage = useSettingsStore(s => s.setPersonLanguage);
  const inputMode = useSettingsStore(s => s.inputMode);

  const isOtherSpeaking =
    activeSpeaker !== null && activeSpeaker !== personId;

  const handlePressIn = useCallback(() => {
    setActiveSpeaker(personId);
    audioCaptureService.start();
    useConversationStore.getState().setPipelineStage('recording');
  }, [personId, setActiveSpeaker]);

  const handlePressOut = useCallback(async () => {
    const audioPath = await audioCaptureService.stop();
    setActiveSpeaker(null);
    if (audioPath) {
      pipelineOrchestrator.submit(personId, audioPath);
    } else {
      useConversationStore.getState().setPipelineStage('idle');
    }
  }, [personId, setActiveSpeaker]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <LanguageSelector
          value={language}
          onChange={code => setPersonLanguage(personId, code)}
          lang={language}
          inverted={inverted}
        />
      </View>

      <View style={styles.messages}>
        <ChatBubbleList messages={messages} viewerPersonId={personId} lang={language} />
      </View>

      {inputMode === 'ptt' ? (
        <SpeakButton
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          pipelineStage={
            activeSpeaker === personId ? pipelineStage : 'idle'
          }
          disabled={isOtherSpeaking}
          lang={language}
        />
      ) : (
        <StatusIndicator stage={pipelineStage} lang={language} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#374151',
  },
  messages: {
    flex: 1,
  },
});
