// LanguagePairScreen — first run / language re-pick.
//
// Visual: two huge typographic cards, swap rail between, primary CTA at
// the bottom. Tapping a card opens a bottom-sheet picker grouped by script
// family. Long-press a filled card to clear it.
//
// The cards are stacked so the user reads them top-down. The conversation
// screen is the diplomatic / table-flat surface; this screen is single-user
// setup and renders upright.

import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import { getLanguage } from '../app/languages';
import { log } from '../services/log/logStore';
import type { RootStackParamList } from '../navigation/types';
import {
  Button,
  DuskBackdrop,
  LanguageCard,
  LanguagePickerSheet,
  SwapButton,
  Text,
  color,
  haptics,
  space,
} from '../ui';

type Props = NativeStackScreenProps<RootStackParamList, 'LanguagePair'>;

type Slot = 'partner' | 'self';

export function LanguagePairScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const personA = useSettingsStore(s => s.personA);
  const personB = useSettingsStore(s => s.personB);
  const setPersonLanguage = useSettingsStore(s => s.setPersonLanguage);
  const setLanguagePairConfigured = useSettingsStore(s => s.setLanguagePairConfigured);

  // Bottom card = self (Person A, "you"). Top card = partner (Person B).
  const partnerCode = personB.language;
  const selfCode = personA.language;

  const partnerLang = partnerCode ? getLanguage(partnerCode) : null;
  const selfLang = selfCode ? getLanguage(selfCode) : null;

  const bothFilled = partnerCode !== '' && selfCode !== '';

  // Picker sheet state.
  const [pickerSlot, setPickerSlot] = useState<Slot | null>(null);

  const openPicker = (slot: Slot) => {
    log.info(`[picker] open slot=${slot} (partner=${partnerCode || '∅'} self=${selfCode || '∅'})`);
    setPickerSlot(slot);
  };
  const closePicker = () => {
    log.info('[picker] close');
    setPickerSlot(null);
  };

  const onPick = (code: string) => {
    const slot = pickerSlot;
    log.info(`[picker] onPick start slot=${slot} code=${code}`);
    try {
      if (slot === 'partner') {
        log.info('[picker] step 1: setPersonLanguage B');
        setPersonLanguage('B', code);
        log.info('[picker] step 1 done');
      } else if (slot === 'self') {
        log.info('[picker] step 1: setPersonLanguage A');
        setPersonLanguage('A', code);
        log.info('[picker] step 1 done');
      } else {
        log.warn(`[picker] onPick called with no slot active`);
      }
      log.info('[picker] step 2: haptics.tick');
      haptics.tick();
      log.info('[picker] step 2 done');
      log.info('[picker] step 3: closePicker');
      closePicker();
      log.info('[picker] step 3 done — onPick complete');
    } catch (e) {
      log.error('[picker] onPick threw', e as Error);
      throw e;
    }
  };

  const clearPartner = () => {
    log.info('[picker] clearPartner');
    setPersonLanguage('B', '');
  };
  const clearSelf = () => {
    log.info('[picker] clearSelf');
    setPersonLanguage('A', '');
  };

  const swap = () => {
    if (!bothFilled) return;
    setPersonLanguage('B', selfCode);
    setPersonLanguage('A', partnerCode);
  };

  const onStart = () => {
    if (!bothFilled) return;
    log.info(`[pair] start: partner=${partnerCode} self=${selfCode}`);
    setLanguagePairConfigured(true);
    haptics.done();
    navigation.replace('Conversation');
  };

  const excludeForPicker =
    pickerSlot === 'partner' ? selfCode : pickerSlot === 'self' ? partnerCode : undefined;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Dusk atmosphere — same warm/cool gradient as the conversation
          surface, so the setup screen lives in the same world. */}
      <DuskBackdrop />

      {/* Hairline header — editorial serif italic, peach + periwinkle dots
          flank the eyebrow as a tiny preview of the speaker palette. */}
      <View style={styles.header}>
        <View style={styles.headerInner}>
          <View style={styles.eyebrowRow}>
            <View style={[styles.eyebrowDot, { backgroundColor: color.accentB }]} />
            <Text variant="caption" tone="fgGhost" style={styles.eyebrow}>
              PARLY — DUSK
            </Text>
            <View style={[styles.eyebrowDot, { backgroundColor: color.accentA }]} />
          </View>
          <Text variant="serifHero" tone="fg" style={styles.headline}>
            Two suns meeting{'\n'}at the edge of the day.
          </Text>
          <Text variant="serif" tone="fgFaint" style={styles.subhead}>
            Pick one for each speaker. You can swap or change them during
            the conversation.
          </Text>
        </View>
      </View>

      {/* Cards */}
      <View style={styles.cards}>
        <LanguageCard
          role="partner"
          language={partnerLang}
          accent={color.accentB}
          onPress={() => openPicker('partner')}
          onClear={partnerLang ? clearPartner : undefined}
        />
        <SwapButton disabled={!bothFilled} onPress={swap} />
        <LanguageCard
          role="self"
          language={selfLang}
          accent={color.accentA}
          onPress={() => openPicker('self')}
          onClear={selfLang ? clearSelf : undefined}
        />
      </View>

      {/* Footer */}
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
        <Button
          label="Start"
          onPress={onStart}
          disabled={!bothFilled}
          style={styles.cta}
        />
        <Pressable
          onPress={() => navigation.navigate('Settings')}
          accessibilityRole="button"
          accessibilityLabel="Open settings">
          <Text variant="serif" tone="fgFaint" style={styles.settingsLink}>
            settings
          </Text>
        </Pressable>
      </View>

      <LanguagePickerSheet
        visible={pickerSlot !== null}
        excludeCode={excludeForPicker}
        onSelect={onPick}
        onClose={closePicker}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
  },
  header: {
    paddingHorizontal: space.xl,
    paddingTop: space.xxl,
    paddingBottom: space.xl,
  },
  headerInner: {},
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: space.md,
  },
  eyebrowDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginHorizontal: 8,
    opacity: 0.85,
  },
  eyebrow: {
    letterSpacing: 2.4,
  },
  headline: {
    marginRight: space.sm,
  },
  subhead: {
    marginTop: space.md,
    paddingRight: space.xl,
    lineHeight: 20,
  },
  cards: {
    flex: 1,
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    justifyContent: 'center',
  },
  footer: {
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    alignItems: 'center',
  },
  cta: {
    alignSelf: 'stretch',
    paddingVertical: 16,
    marginBottom: space.md,
    borderRadius: 16,
  },
  settingsLink: {
    paddingVertical: space.xs,
  },
});
