import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useConversationStore } from '../../store/conversationStore';
import { useSettingsStore } from '../../store/settingsStore';
import type { PersonId } from '../../app/types';
import { BreathingOrb } from './BreathingOrb';
import { WaveformIndicator } from './WaveformIndicator';
import { SubtitleView } from './SubtitleView';
import { LanguageToast } from './LanguageToast';

interface Props {
  readonly personId: PersonId;
}

/**
 * Derives display content for one half of the split screen.
 *
 * Priority:
 * 1. If this person is actively speaking → show their live originalText + waveform
 * 2. If there's a completed translation for this person (from the other side) → show it
 * 3. Otherwise → breathing orb
 *
 * Ghost is the previous entry in the same category (own speech or received translation).
 */
function usePanelContent(personId: PersonId) {
  const messages = useConversationStore(s => s.messages);
  const activeSpeaker = useConversationStore(s => s.activeSpeaker);
  const pipelineStage = useConversationStore(s => s.pipelineStage);
  const detectedLangs = useConversationStore(s => s.detectedLangs);

  const personLang = useSettingsStore(s =>
    personId === 'person_a' ? s.personA.language : s.personB.language,
  );

  return useMemo(() => {
    const detection = detectedLangs[personId];
    // In VAD mode the speaker isn't known until after transcription,
    // so show waveform on both halves during 'recording'.
    const isSpeaking =
      pipelineStage === 'recording' ||
      (activeSpeaker === personId && pipelineStage === 'listening');

    // Messages sent BY this person (what they said, shown as confirmation)
    const ownMessages = messages.filter(m => m.speakerId === personId);

    // Messages FROM the other person that now have a translation for this person
    // (translatedText is in this person's language)
    const receivedMessages = messages.filter(
      m => m.speakerId !== personId && (m.stage === 'done' || m.stage === 'translating'),
    );

    // Most recent own utterance
    const latestOwn = ownMessages.at(-1);
    const prevOwn = ownMessages.at(-2);

    // Most recent received translation (fully done)
    const latestReceived = receivedMessages.at(-1);
    const prevReceived = receivedMessages.at(-2);

    // Decide what to show as the primary content
    const latestOwnTs = latestOwn?.timestamp ?? 0;
    const latestReceivedTs = latestReceived?.timestamp ?? 0;

    // If actively speaking — show waveform (and text if available)
    if (isSpeaking) {
      return {
        showOrb: false,
        showWaveform: true,
        mainText: latestOwn?.originalText || '',
        originalText: undefined,
        ghostText: prevOwn?.originalText,
        detection,
        personLang,
      };
    }

    // Most recent event wins (own speech vs received translation)
    if (latestReceivedTs > latestOwnTs && latestReceived) {
      // Show translation received from other side
      const ghost = prevReceived?.translatedText ?? prevOwn?.originalText;
      return {
        showOrb: false,
        showWaveform: false,
        mainText: latestReceived.translatedText ?? latestReceived.originalText,
        originalText: latestReceived.originalText,
        ghostText: ghost ?? undefined,
        detection,
        personLang,
      };
    }

    if (latestOwn) {
      // Show own most-recent speech (dimmed — they already said it)
      return {
        showOrb: false,
        showWaveform: isSpeaking,
        mainText: latestOwn.originalText,
        originalText: undefined,
        ghostText: prevOwn?.originalText,
        detection,
        personLang,
      };
    }

    // Nothing yet — idle state
    return {
      showOrb: true,
      showWaveform: false,
      mainText: '',
      originalText: undefined,
      ghostText: undefined,
      detection,
      personLang,
    };
  }, [messages, activeSpeaker, pipelineStage, detectedLangs, personId, personLang]);
}

export function GlassPanel({ personId }: Props): React.JSX.Element {
  const {
    showOrb,
    showWaveform,
    mainText,
    originalText,
    ghostText,
    detection,
  } = usePanelContent(personId);

  const activeSpeaker = useConversationStore(s => s.activeSpeaker);
  const otherSpeaking = activeSpeaker !== null && activeSpeaker !== personId;

  return (
    <View style={styles.container}>
      {showOrb ? (
        <BreathingOrb dimmed={otherSpeaking} />
      ) : (
        <SubtitleView
          mainText={mainText}
          originalText={originalText}
          ghostText={ghostText}
        />
      )}

      {showWaveform ? (
        <View style={styles.waveform}>
          <WaveformIndicator />
        </View>
      ) : null}

      {detection ? (
        <View style={styles.toast}>
          <LanguageToast lang={detection.lang} timestamp={detection.timestamp} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 48,
  },
  waveform: {
    marginTop: 20,
  },
  toast: {
    position: 'absolute',
    bottom: 20,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
});
