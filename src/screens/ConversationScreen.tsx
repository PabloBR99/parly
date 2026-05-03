// ConversationScreen — bidirectional translation surface (Dusk).

import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StatusBar, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import { useConversationStore } from '../store/conversationStore';
import { useNetworkStore } from '../store/networkStore';
import { getOrchestrator } from '../services/pipeline/orchestrator';
import type { PersonId } from '../app/types';
import type { RootStackParamList } from '../navigation/types';
import {
  DuskBackdrop,
  LanguagePickerSheet,
  Text,
  color,
  haptics,
  space,
} from '../ui';
import { SpeakerHalf } from './conversation/SpeakerHalf';
import { NetworkPill } from './conversation/NetworkPill';
import { findLastTurn, useTurnHaptics } from './conversation/helpers';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

type PickerSlot = 'partner' | 'self' | null;

export function ConversationScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const personA = useSettingsStore(s => s.personA);
  const personB = useSettingsStore(s => s.personB);
  const setPersonLanguage = useSettingsStore(s => s.setPersonLanguage);
  const apiKey = useSettingsStore(s => s.mistralApiKey);
  const translationModel = useSettingsStore(s => s.translationModel);
  const turns = useConversationStore(s => s.turns);
  const activeTurnId = useConversationStore(s => s.activeTurnId);
  const networkState = useNetworkStore(s => s.state);
  const [pickerSlot, setPickerSlot] = useState<PickerSlot>(null);

  useEffect(() => {
    getOrchestrator().configure({ apiKey, translationModel });
    if (apiKey) {
      void getOrchestrator().prewarm().catch(() => {});
    }
  }, [apiKey, translationModel]);

  const activeTurn = useMemo(
    () => turns.find(t => t.id === activeTurnId) ?? null,
    [turns, activeTurnId],
  );
  const lastTurnA = useMemo(() => findLastTurn(turns, 'person_a'), [turns]);
  const lastTurnB = useMemo(() => findLastTurn(turns, 'person_b'), [turns]);

  useTurnHaptics(activeTurn, lastTurnA, lastTurnB);

  const noKey = apiKey.trim() === '';

  const handleMicPressIn = (speakerId: PersonId) => {
    if (noKey) return;
    if (activeTurn && activeTurn.stage !== 'done' && activeTurn.stage !== 'error') {
      return;
    }
    const sourceLang = speakerId === 'person_a' ? personA.language : personB.language;
    const targetLang = speakerId === 'person_a' ? personB.language : personA.language;
    if (!sourceLang || !targetLang) return;

    void getOrchestrator()
      .beginTurn({ speakerId, sourceLang, targetLang })
      .catch(err => console.warn('[Conversation] turn failed:', err));
  };

  const handleMicPressOut = () => {
    void getOrchestrator().endTurn().catch(err => {
      console.warn('[Conversation] endTurn failed:', err);
    });
  };

  const onPickLanguage = (code: string) => {
    if (pickerSlot === 'partner') setPersonLanguage('B', code);
    else if (pickerSlot === 'self') setPersonLanguage('A', code);
    setPickerSlot(null);
  };

  const topActiveTurn = activeTurn?.speakerId === 'person_b' ? activeTurn : null;
  const bottomActiveTurn = activeTurn?.speakerId === 'person_a' ? activeTurn : null;

  const firstRun = !noKey && turns.length === 0;

  const topIncomingTurn = lastTurnA;
  const bottomIncomingTurn = lastTurnB;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={color.bg} />
      <DuskBackdrop />

      {/* TOP HALF — rotated 180deg so the partner sees everything upright. */}
      <View style={styles.half}>
        <View style={styles.flipped}>
          <SpeakerHalf
            speakerLanguage={personB.language}
            partnerLanguage={personA.language}
            activeTurn={topActiveTurn}
            incomingTurn={topIncomingTurn}
            accent={color.accentB}
            accentRing={color.accentBRing}
            edgePadding={insets.top + space.md}
            edgeContent={<NetworkPill state={networkState} />}
            disabled={noKey || (!!activeTurn && activeTurn?.speakerId !== 'person_b')}
            firstRun={firstRun}
            onPressIn={() => handleMicPressIn('person_b')}
            onPressOut={handleMicPressOut}
            onChangeLanguage={() => setPickerSlot('partner')}
          />
        </View>
      </View>

      {/* BOTTOM HALF — user's upright view. */}
      <View style={styles.half}>
        <SpeakerHalf
          speakerLanguage={personA.language}
          partnerLanguage={personB.language}
          activeTurn={bottomActiveTurn}
          incomingTurn={bottomIncomingTurn}
          accent={color.accentA}
          accentRing={color.accentARing}
          edgePadding={insets.bottom + space.md}
          edgeContent={
            <Pressable
              onPress={() => navigation.navigate('Settings')}
              hitSlop={14}
              accessibilityRole="button"
              accessibilityLabel="Settings">
              <Text variant="serif" tone="fgFaint" style={styles.settingsLink}>
                settings
              </Text>
            </Pressable>
          }
          disabled={noKey || (!!activeTurn && activeTurn?.speakerId !== 'person_a')}
          firstRun={firstRun}
          onPressIn={() => handleMicPressIn('person_a')}
          onPressOut={handleMicPressOut}
          onChangeLanguage={() => setPickerSlot('self')}
        />
      </View>

      {noKey && (
        <View style={styles.bannerWrap} pointerEvents="box-none">
          <Pressable
            style={styles.banner}
            onPress={() => navigation.navigate('Settings')}>
            <Text variant="caption" tone="fgFaint" style={styles.bannerEyebrow}>
              BEFORE WE START
            </Text>
            <Text variant="body" tone="fg" style={styles.bannerBody}>
              Connect Parly to its brain.
            </Text>
            <Text variant="bodySmall" tone="fgMuted" style={styles.bannerHint}>
              Tap here — we'll walk you through it.
            </Text>
          </Pressable>
        </View>
      )}

      <LanguagePickerSheet
        side="top"
        visible={pickerSlot === 'partner'}
        excludeCode={personA.language}
        onSelect={onPickLanguage}
        onClose={() => setPickerSlot(null)}
      />
      <LanguagePickerSheet
        side="bottom"
        visible={pickerSlot === 'self'}
        excludeCode={personB.language}
        onSelect={onPickLanguage}
        onClose={() => setPickerSlot(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  half: { flex: 1 },
  flipped: { flex: 1, transform: [{ rotate: '180deg' }] },
  settingsLink: {
    paddingVertical: space.xs,
  },
  bannerWrap: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    top: '47%',
    alignItems: 'center',
  },
  banner: {
    backgroundColor: '#0E0E0E',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    alignItems: 'center',
    minWidth: 240,
  },
  bannerEyebrow: {
    marginBottom: 6,
  },
  bannerBody: {
    marginBottom: 4,
  },
  bannerHint: {},
});
