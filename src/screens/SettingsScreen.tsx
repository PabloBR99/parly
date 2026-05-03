// SettingsScreen — configuration surface, with a non-technical user
// (Mom-test) onboarding flow when no API key is configured yet.

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import { useConversationStore } from '../store/conversationStore';
import { validateMistralApiKey, type KeyValidation } from '../services/auth/validateApiKey';
import { log } from '../services/log/logStore';
import type { RootStackParamList } from '../navigation/types';
import {
  Button,
  DuskBackdrop,
  Surface,
  Text,
  color,
  haptics,
  radius,
  space,
} from '../ui';
import { Section } from './settings/Section';
import { KeyValidationLine } from './settings/KeyValidationLine';
import { OnboardingSteps } from './settings/OnboardingSteps';

const MISTRAL_CONSOLE_URL = 'https://console.mistral.ai/api-keys';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export function SettingsScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const apiKey = useSettingsStore(s => s.mistralApiKey);
  const setApiKey = useSettingsStore(s => s.setMistralApiKey);
  const clearConversation = useConversationStore(s => s.clear);

  const [keyValidation, setKeyValidation] = useState<KeyValidation | null>(null);
  const [validating, setValidating] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const inputFocusedRef = useRef(false);
  const scrollYRef = useRef(0);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', e => {
      if (!inputFocusedRef.current || !inputRef.current || !scrollRef.current) return;
      const kbHeight = e.endCoordinates.height;
      inputRef.current.measure((_fx, _fy, _w, h, _px, py) => {
        const screenHeight = Dimensions.get('window').height;
        const inputBottom = py + h;
        const visibleBottom = screenHeight - kbHeight;
        const breathing = 120;
        if (inputBottom > visibleBottom - breathing) {
          const delta = inputBottom - (visibleBottom - breathing);
          scrollRef.current?.scrollTo({
            y: scrollYRef.current + delta,
            animated: true,
          });
        }
      });
    });
    return () => showSub.remove();
  }, []);

  const onApiInputFocus = () => { inputFocusedRef.current = true; };
  const onApiInputBlur = () => { inputFocusedRef.current = false; };

  const onValidateKey = async () => {
    haptics.tap();
    setValidating(true);
    setKeyValidation(null);
    try {
      const result = await validateMistralApiKey(apiKey);
      setKeyValidation(result);
      if (result.status === 'ok') haptics.tick();
      else haptics.error();
    } finally {
      setValidating(false);
    }
  };

  const onClearHistory = () => {
    haptics.done();
    clearConversation();
    navigation.goBack();
  };

  const openMistralConsole = () => {
    haptics.tap();
    Linking.openURL(MISTRAL_CONSOLE_URL).catch((err) => {
      log.warn('[settings] could not open Mistral console', String(err));
    });
  };

  const onStartConversation = () => {
    haptics.done();
    navigation.goBack();
  };

  const noKey = apiKey.trim() === '';
  const keyOk = keyValidation?.status === 'ok';

  return (
    <View style={styles.root}>
      <DuskBackdrop />
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + space.xxl + 280 },
        ]}
        onScroll={e => {
          scrollYRef.current = e.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled">
          {/* HEADER */}
          <View style={styles.header}>
            <View style={styles.eyebrowRow}>
              <View style={[styles.eyebrowDot, { backgroundColor: color.accentB }]} />
              <Text variant="caption" tone="fgGhost" style={styles.eyebrow}>
                PARLY
              </Text>
              <View style={[styles.eyebrowDot, { backgroundColor: color.accentA }]} />
            </View>
            <Text variant="serifHero" tone="fg">
              {noKey ? 'Welcome.' : 'Settings.'}
            </Text>
            <Text variant="serif" tone="fgFaint" style={styles.subhead}>
              {noKey
                ? "Let's get Parly up and running in three steps."
                : 'Manage your connection and clear history.'}
            </Text>
          </View>

          {noKey ? (
            <View style={styles.section}>
              <OnboardingSteps
                apiKey={apiKey}
                keyValidation={keyValidation}
                validating={validating}
                keyOk={keyOk}
                onChangeKey={(v) => {
                  setApiKey(v);
                  setKeyValidation(null);
                }}
                onOpenConsole={openMistralConsole}
                onValidate={onValidateKey}
                onStart={onStartConversation}
                inputRef={inputRef}
                onApiInputFocus={onApiInputFocus}
                onApiInputBlur={onApiInputBlur}
              />
            </View>
          ) : (
            <Section label="CONNECTION">
              <Surface style={styles.connectedCard}>
                <View style={styles.connectedRow}>
                  <View style={[styles.connectedDot, { backgroundColor: color.ok }]} />
                  <View style={styles.flex}>
                    <Text variant="body" tone="fg">Connected to Mistral</Text>
                    <Text variant="bodySmall" tone="fgFaint">
                      Your key is stored securely on this device.
                    </Text>
                  </View>
                </View>
              </Surface>
              <View style={styles.keyActionRow}>
                <KeyValidationLine state={keyValidation} validating={validating} />
                <Pressable
                  onPress={onValidateKey}
                  disabled={validating}
                  accessibilityRole="button"
                  accessibilityLabel="Check connection"
                  style={({ pressed }) => [
                    styles.verifyBtn,
                    pressed && styles.verifyBtnPressed,
                    validating && styles.verifyBtnDisabled,
                  ]}>
                  {validating ? (
                    <ActivityIndicator color={color.fgMuted} size="small" />
                  ) : (
                    <Text variant="serifSmall" tone="fgMuted">check</Text>
                  )}
                </Pressable>
              </View>
              <Pressable
                onPress={() => {
                  haptics.tap();
                  setApiKey('');
                  setKeyValidation(null);
                }}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Change key"
                style={({ pressed }) => [styles.replaceLink, pressed && styles.replaceLinkPressed]}>
                <Text variant="serifSmall" tone="fgFaint">
                  change key
                </Text>
              </Pressable>
            </Section>
          )}

          {!noKey && (
            <>
              <Section label="CONVERSATION">
                <Button
                  label="Clear history"
                  variant="danger"
                  onPress={onClearHistory}
                />
              </Section>

              <Section label="DIAGNOSTICS">
                <Button
                  label="View logs"
                  variant="secondary"
                  onPress={() => navigation.navigate('Logs')}
                />
              </Section>
            </>
          )}

          <Text variant="serif" tone="fgGhost" style={styles.versionTag}>
            PARLY — DUSK
          </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  flex: { flex: 1 },
  content: {
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
  },
  header: {
    paddingTop: space.md,
    paddingBottom: space.xxl,
  },
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
  subhead: {
    marginTop: space.md,
    paddingRight: space.xl,
    lineHeight: 20,
  },
  section: {
    marginBottom: space.xxl,
  },
  connectedCard: {
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  connectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  connectedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: space.sm,
  },
  keyActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.sm,
    paddingHorizontal: 4,
    minHeight: 30,
  },
  verifyBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.hairlineStrong,
    minWidth: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verifyBtnPressed: {
    backgroundColor: color.surface2,
  },
  verifyBtnDisabled: {
    opacity: 0.4,
  },
  replaceLink: {
    alignSelf: 'flex-start',
    marginTop: space.sm,
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  replaceLinkPressed: {
    opacity: 0.5,
  },
  versionTag: {
    textAlign: 'center',
    marginTop: space.lg,
    opacity: 0.45,
  },
});
