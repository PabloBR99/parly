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
import {
  TRANSCRIPTION_MODES,
  TRANSLATION_MODELS,
  useSettingsStore,
} from '../store/settingsStore';
import { formatPeople, parsePeople } from '../app/names';
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
  const keyStatus = useSettingsStore(s => s.keyStatus);
  const setApiKey = useSettingsStore(s => s.setMistralApiKey);
  const setKeyStatus = useSettingsStore(s => s.setKeyStatus);
  const translationModel = useSettingsStore(s => s.translationModel);
  const setTranslationModel = useSettingsStore(s => s.setTranslationModel);
  const transcriptionMode = useSettingsStore(s => s.transcriptionMode);
  const setTranscriptionMode = useSettingsStore(s => s.setTranscriptionMode);
  const people = useSettingsStore(s => s.people);
  const setPeople = useSettingsStore(s => s.setPeople);
  const clearConversation = useConversationStore(s => s.clear);

  // Committed on blur, not on every keystroke: each commit rebuilds the name
  // index and re-configures the pipeline, and neither is anyone's business
  // halfway through typing a name.
  const [draftPeople, setDraftPeople] = useState(() => formatPeople(people));

  // The settings store hydrates from disk asynchronously, so the first render
  // of this screen can carry the seeded defaults rather than the saved list.
  // Without this the field would show the wrong names and — worse — blurring
  // it would commit them over the saved ones.
  useEffect(() => {
    setDraftPeople(formatPeople(people));
  }, [people]);

  const [keyValidation, setKeyValidation] = useState<KeyValidation | null>(null);
  const [validating, setValidating] = useState(false);
  // "Change key" flow: the working key stays untouched until a NEW key
  // validates. A single tap must never be able to strand the user keyless —
  // Mistral's console never re-shows an existing key.
  const [editingKey, setEditingKey] = useState(false);
  const [draftKey, setDraftKey] = useState('');

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

  const applyValidationResult = (result: KeyValidation) => {
    setKeyValidation(result);
    if (result.status === 'ok') {
      setKeyStatus('valid');
      haptics.tick();
    } else if (result.status === 'invalid' || result.status === 'malformed') {
      setKeyStatus('invalid');
      haptics.error();
    } else {
      // network/unknown — not the key's fault; leave the status alone.
      haptics.error();
    }
  };

  /** Validate the stored key (onboarding + "check" button). */
  const onValidateKey = async () => {
    haptics.tap();
    setValidating(true);
    setKeyValidation(null);
    try {
      applyValidationResult(await validateMistralApiKey(apiKey));
    } finally {
      setValidating(false);
    }
  };

  /** Validate the DRAFT key; only replace the stored key on success. */
  const onValidateDraft = async () => {
    haptics.tap();
    setValidating(true);
    setKeyValidation(null);
    try {
      const result = await validateMistralApiKey(draftKey);
      setKeyValidation(result);
      if (result.status === 'ok') {
        setApiKey(draftKey.trim());
        setKeyStatus('valid');
        setEditingKey(false);
        setDraftKey('');
        haptics.tick();
      } else {
        haptics.error();
      }
    } finally {
      setValidating(false);
    }
  };

  const onStartEditingKey = () => {
    haptics.tap();
    setDraftKey('');
    setKeyValidation(null);
    setEditingKey(true);
  };

  const onCancelEditingKey = () => {
    haptics.tap();
    setEditingKey(false);
    setDraftKey('');
    setKeyValidation(null);
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

  const connectionCard = (() => {
    if (keyStatus === 'valid') {
      return {
        dot: color.ok,
        title: 'Connected to Mistral',
        subtitle: 'Your key is stored securely on this device.',
      };
    }
    if (keyStatus === 'invalid') {
      return {
        dot: color.error,
        title: "The key isn't working",
        subtitle: 'Enter a new key below — the old one stays until it verifies.',
      };
    }
    return {
      dot: color.warn,
      title: 'Key added — not verified yet',
      subtitle: 'Tap "check" to confirm it works.',
    };
  })();

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
                  <View style={[styles.connectedDot, { backgroundColor: connectionCard.dot }]} />
                  <View style={styles.flex}>
                    <Text variant="body" tone="fg">{connectionCard.title}</Text>
                    <Text variant="bodySmall" tone="fgFaint">
                      {connectionCard.subtitle}
                    </Text>
                  </View>
                </View>
              </Surface>

              {!editingKey && (
                <>
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
                    onPress={onStartEditingKey}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel="Change key"
                    style={({ pressed }) => [styles.replaceLink, pressed && styles.replaceLinkPressed]}>
                    <Text variant="serifSmall" tone="fgFaint">
                      change key
                    </Text>
                  </Pressable>
                </>
              )}

              {editingKey && (
                <View style={styles.editZone}>
                  <Text variant="bodySmall" tone="fgMuted" style={styles.editHint}>
                    Paste the new key. Your current key keeps working until the
                    new one verifies.
                  </Text>
                  <Surface style={styles.editInputCard}>
                    <TextInput
                      value={draftKey}
                      onChangeText={setDraftKey}
                      autoCapitalize="none"
                      autoCorrect={false}
                      spellCheck={false}
                      style={styles.editInput}
                      placeholder="Paste the new key here"
                      placeholderTextColor={color.fgGhost}
                    />
                  </Surface>
                  <View style={styles.editActions}>
                    <Pressable
                      onPress={onValidateDraft}
                      disabled={validating || draftKey.trim() === ''}
                      accessibilityRole="button"
                      accessibilityLabel="Verify the new key"
                      style={({ pressed }) => [
                        styles.verifyBtn,
                        pressed && styles.verifyBtnPressed,
                        (validating || draftKey.trim() === '') && styles.verifyBtnDisabled,
                      ]}>
                      {validating ? (
                        <ActivityIndicator color={color.fgMuted} size="small" />
                      ) : (
                        <Text variant="serifSmall" tone="fgMuted">verify &amp; replace</Text>
                      )}
                    </Pressable>
                    <Pressable
                      onPress={onCancelEditingKey}
                      hitSlop={10}
                      accessibilityRole="button"
                      accessibilityLabel="Keep the current key"
                      style={({ pressed }) => [styles.replaceLink, pressed && styles.replaceLinkPressed]}>
                      <Text variant="serifSmall" tone="fgFaint">keep current key</Text>
                    </Pressable>
                  </View>
                  <View style={styles.feedbackRow}>
                    <KeyValidationLine state={keyValidation} validating={validating} />
                  </View>
                </View>
              )}
            </Section>
          )}

          {!noKey && (
            <>
              <Section label="TRANSLATION">
                {TRANSLATION_MODELS.map(m => {
                  const selected = m.id === translationModel;
                  return (
                    <Pressable
                      key={m.id}
                      onPress={() => {
                        haptics.tick();
                        setTranslationModel(m.id);
                      }}
                      accessibilityRole="radio"
                      accessibilityLabel={m.label}
                      accessibilityState={{ selected }}
                      style={({ pressed }) => [
                        styles.modelRow,
                        pressed && styles.modelRowPressed,
                        selected && styles.modelRowSelected,
                      ]}>
                      <View
                        style={[styles.modelRadio, selected && styles.modelRadioSelected]}
                      />
                      <Text variant="body" tone={selected ? 'fg' : 'fgMuted'}>
                        {m.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </Section>

              <Section label="TRANSCRIPTION">
                {TRANSCRIPTION_MODES.map(m => {
                  const selected = m.id === transcriptionMode;
                  return (
                    <Pressable
                      key={m.id}
                      onPress={() => {
                        haptics.tick();
                        setTranscriptionMode(m.id);
                      }}
                      accessibilityRole="radio"
                      accessibilityLabel={m.label}
                      accessibilityState={{ selected }}
                      style={({ pressed }) => [
                        styles.modelRow,
                        pressed && styles.modelRowPressed,
                        selected && styles.modelRowSelected,
                      ]}>
                      <View
                        style={[styles.modelRadio, selected && styles.modelRadioSelected]}
                      />
                      <Text variant="body" tone={selected ? 'fg' : 'fgMuted'}>
                        {m.label}
                      </Text>
                    </Pressable>
                  );
                })}
                <Text variant="serifSmall" tone="fgFaint" style={styles.hintLine}>
                  Accurate gives the recogniser more of the sentence before it
                  commits to a word. Fast answers sooner and slips more on quick
                  speech.
                </Text>
              </Section>

              <Section label="NAMES">
                <Surface style={styles.editInputCard}>
                  <TextInput
                    value={draftPeople}
                    onChangeText={setDraftPeople}
                    onBlur={() => setPeople(parsePeople(draftPeople))}
                    onSubmitEditing={() => setPeople(parsePeople(draftPeople))}
                    autoCapitalize="words"
                    autoCorrect={false}
                    spellCheck={false}
                    multiline
                    style={styles.editInput}
                    placeholder="Ana, Bruno, José Antonio"
                    placeholderTextColor={color.fgGhost}
                    accessibilityLabel="Names used in this conversation"
                  />
                </Surface>
                <Text variant="serifSmall" tone="fgFaint" style={styles.hintLine}>
                  Who is in the conversation, spelled the way you want to see
                  them. Names are what speech recognition gets wrong most, and
                  this is what it corrects towards.
                </Text>
              </Section>

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
  hintLine: { marginTop: space.sm, lineHeight: 18 },
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
  editZone: {
    marginTop: space.md,
  },
  editHint: {
    marginBottom: space.sm,
    paddingHorizontal: 4,
  },
  editInputCard: {
    paddingVertical: 4,
  },
  editInput: {
    color: color.fg,
    fontSize: 15,
    paddingHorizontal: space.sm,
    paddingVertical: 12,
    letterSpacing: 0.2,
  },
  editActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  feedbackRow: {
    minHeight: 22,
    marginTop: space.xs,
    paddingHorizontal: 4,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: 12,
    borderRadius: radius.md,
    marginBottom: 2,
  },
  modelRowPressed: {
    backgroundColor: color.surface2,
  },
  modelRowSelected: {
    backgroundColor: color.surface1,
  },
  modelRadio: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: color.hairlineStrong,
    marginRight: space.sm,
  },
  modelRadioSelected: {
    borderColor: color.ok,
    backgroundColor: color.ok,
  },
  versionTag: {
    textAlign: 'center',
    marginTop: space.lg,
    opacity: 0.45,
  },
});
