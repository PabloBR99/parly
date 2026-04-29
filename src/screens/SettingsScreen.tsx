// SettingsScreen — configuration surface, with a non-technical user
// (Mom-test) onboarding flow when no API key is configured yet.
//
// First run (no key):
//   "Welcome" header + 3 guided steps in plain English:
//     1. Open the Mistral console (Linking.openURL).
//     2. Copy the key from "Create new key".
//     3. Paste here, verify, then go back to the conversation.
//   Lower (technical) sections are HIDDEN to keep the welcome focused.
//
// Returning user (key set):
//   Compact "Connected to Mistral" card with `check` (re-run validation)
//   and `change key` (clear → re-enter onboarding). Conversation cleanup
//   and diagnostics are revealed below.
//
// Languages are picked from the conversation screen (tap the chip on
// each side). The translation model is fixed to Mistral Small for this
// build — no selector exposed.

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

const MISTRAL_CONSOLE_URL = 'https://console.mistral.ai/api-keys';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export function SettingsScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const apiKey = useSettingsStore(s => s.mistralApiKey);
  const setApiKey = useSettingsStore(s => s.setMistralApiKey);
  const clearConversation = useConversationStore(s => s.clear);

  // API-key validation state. `null` = not yet checked since last edit.
  const [keyValidation, setKeyValidation] = useState<KeyValidation | null>(null);
  const [validating, setValidating] = useState(false);

  // API-key field flow. With Android `adjustResize` the activity content
  // shrinks when the keyboard appears, but a focused input deep in a
  // ScrollView does not auto-scroll into view. The fix: when the keyboard
  // shows AND our input is focused, measure the input's window position,
  // compare against the keyboard top, and scroll up by the overlap so the
  // input sits ~40px above the keyboard. This leaves room to long-press →
  // Paste comfortably.
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
        // Generous gap so the input lifts well clear of the keyboard —
        // makes the long-press → Paste menu fall in the open space above
        // it instead of being chopped at the keyboard edge.
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
          // Generous bottom room so we can scroll the API input well above
          // any Android keyboard (~280-340px tall) without bumping into the
          // end of the content.
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
                PARLY — DUSK
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

          {/* CONEXIÓN — guided onboarding when empty, compact status when set. */}
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
                <Text variant="serifSmall" tone="fgFaint" style={styles.replaceLabel}>
                  change key
                </Text>
              </Pressable>
            </Section>
          )}

          {/* Lower sections — hidden until the user has a working connection.
              On first run there's no history to clear and no diagnostics to
              show, and the visual silence keeps the welcome focused. */}
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

// ── Key validation feedback ──────────────────────────────────────────────────

function KeyValidationLine({
  state,
  validating,
}: {
  readonly state: KeyValidation | null;
  readonly validating: boolean;
}): React.JSX.Element {
  if (validating) {
    return (
      <Text variant="mono" tone="fgFaint" style={styles.keyStatus}>
        CHECKING…
      </Text>
    );
  }
  if (state === null) {
    return <View style={styles.keyStatus} />;
  }
  if (state.status === 'ok') {
    return (
      <Text variant="mono" tone="ok" style={styles.keyStatus}>
        ●  KEY VALID
      </Text>
    );
  }
  if (state.status === 'invalid') {
    return (
      <Text variant="mono" tone="error" style={styles.keyStatus}>
        ●  KEY REJECTED
      </Text>
    );
  }
  if (state.status === 'network') {
    return (
      <Text variant="mono" tone="warn" style={styles.keyStatus}>
        ●  NO NETWORK
      </Text>
    );
  }
  return (
    <Text variant="mono" tone="warn" style={styles.keyStatus}>
      ●  HTTP {state.httpStatus}
    </Text>
  );
}

// ── Onboarding (first-run guided setup) ──────────────────────────────────────

interface OnboardingStepsProps {
  readonly apiKey: string;
  readonly keyValidation: KeyValidation | null;
  readonly validating: boolean;
  readonly keyOk: boolean;
  readonly onChangeKey: (v: string) => void;
  readonly onOpenConsole: () => void;
  readonly onValidate: () => void;
  readonly onStart: () => void;
  readonly inputRef: React.RefObject<TextInput | null>;
  readonly onApiInputFocus: () => void;
  readonly onApiInputBlur: () => void;
}

function OnboardingSteps({
  apiKey,
  keyValidation,
  validating,
  keyOk,
  onChangeKey,
  onOpenConsole,
  onValidate,
  onStart,
  inputRef,
  onApiInputFocus,
  onApiInputBlur,
}: OnboardingStepsProps): React.JSX.Element {
  const hasInput = apiKey.trim().length > 0;
  return (
    <View>
      <Text variant="body" tone="fgMuted" style={styles.onboardingIntro}>
        To understand and translate your voice, Parly connects to an AI
        service called Mistral. It's free and only needs an email
        address.
      </Text>

      <Step
        number="1"
        title="Create your Mistral account">
        <Text variant="body" tone="fgMuted" style={styles.stepBody}>
          Tap the button below. Mistral's website will open in your
          browser. Sign up or log in.
        </Text>
        <Pressable
          onPress={onOpenConsole}
          accessibilityRole="button"
          accessibilityLabel="Open Mistral's website"
          style={({ pressed }) => [styles.linkBtn, pressed && styles.linkBtnPressed]}>
          <Text variant="body" tone="fg" style={styles.linkBtnLabel}>
            Open Mistral
          </Text>
          <Text variant="body" tone="fgMuted" style={styles.linkBtnArrow}>
            ↗
          </Text>
        </Pressable>
      </Step>

      <Step
        number="2"
        title="Copy your key">
        <Text variant="body" tone="fgMuted" style={styles.stepBody}>
          Once you're in, tap <Text style={styles.inlineEmph}>Create new key</Text>.
          A long code will appear on screen — long-press it and copy the
          whole thing.
        </Text>
      </Step>

      <Step
        number="3"
        title="Paste it here">
        <Surface style={styles.inputCard}>
          <TextInput
            ref={inputRef}
            value={apiKey}
            onChangeText={onChangeKey}
            onFocus={onApiInputFocus}
            onBlur={onApiInputBlur}
            secureTextEntry={false}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={styles.input}
            placeholder="Paste your key here"
            placeholderTextColor={color.fgGhost}
          />
        </Surface>
        <Text variant="bodySmall" tone="fgFaint" style={styles.tip}>
          Long-press the box and tap <Text style={styles.inlineEmph}>Paste</Text>.
        </Text>

        {hasInput && (
          <View style={styles.verifyZone}>
            <Pressable
              onPress={onValidate}
              disabled={validating}
              accessibilityRole="button"
              accessibilityLabel="Verify the key"
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.primaryBtnPressed,
                validating && styles.primaryBtnDisabled,
              ]}>
              {validating ? (
                <ActivityIndicator color={color.fgInk} size="small" />
              ) : (
                <Text variant="body" tone="fgInk" style={styles.primaryBtnLabel}>
                  Verify key
                </Text>
              )}
            </Pressable>
            <View style={styles.feedbackRow}>
              <KeyValidationLine state={keyValidation} validating={validating} />
            </View>
          </View>
        )}

        {keyOk && (
          <View style={styles.successZone}>
            <Text variant="body" tone="ok" style={styles.successLine}>
              ✓  All set. You can start talking now.
            </Text>
            <Pressable
              onPress={onStart}
              accessibilityRole="button"
              accessibilityLabel="Start talking"
              style={({ pressed }) => [
                styles.startBtn,
                pressed && styles.startBtnPressed,
              ]}>
              <Text variant="body" tone="fg" style={styles.startBtnLabel}>
                Start talking  →
              </Text>
            </Pressable>
          </View>
        )}
      </Step>
    </View>
  );
}

function Step({
  number,
  title,
  children,
}: {
  readonly number: string;
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.step}>
      <View style={styles.stepHeader}>
        <View style={styles.stepNumber}>
          <Text variant="mono" tone="fg" style={styles.stepNumberLabel}>
            {number}
          </Text>
        </View>
        <Text variant="body" tone="fg" style={styles.stepTitle}>
          {title}
        </Text>
      </View>
      <View style={styles.stepContent}>{children}</View>
    </View>
  );
}

// ── Section header ───────────────────────────────────────────────────────────

function Section({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text variant="caption" tone="fgFaint" style={styles.sectionLabel}>
        {label}
      </Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
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
  sectionLabel: {
    marginBottom: space.sm,
    letterSpacing: 1.8,
  },
  sectionBody: {},

  inputCard: {
    paddingVertical: 4,
  },
  input: {
    color: color.fg,
    fontSize: 15,
    fontFamily: undefined,
    paddingHorizontal: space.sm,
    paddingVertical: 12,
    letterSpacing: 0.2,
  },
  hint: {
    marginTop: space.xs,
    paddingHorizontal: 4,
    lineHeight: 19,
  },
  mono: {
    fontFamily: 'monospace',
  },
  keyActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.sm,
    paddingHorizontal: 4,
    minHeight: 30,
  },
  keyStatus: {
    flex: 1,
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

  versionTag: {
    textAlign: 'center',
    marginTop: space.lg,
    opacity: 0.45,
  },

  // ── Onboarding (first-run) ────────────────────────────────────────────────
  flex: { flex: 1 },
  onboardingIntro: {
    lineHeight: 22,
    marginBottom: space.xxl,
  },
  step: {
    marginBottom: space.xl,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: space.sm,
  },
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: color.hairlineStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: space.sm,
  },
  stepNumberLabel: {
    fontSize: 13,
    letterSpacing: 0,
  },
  stepTitle: {
    flex: 1,
    fontWeight: '500',
  },
  stepContent: {
    paddingLeft: 28 + space.sm, // align with title
  },
  stepBody: {
    lineHeight: 22,
    marginBottom: space.md,
  },
  inlineEmph: {
    fontFamily: 'monospace',
    color: color.fg,
  },
  tip: {
    marginTop: space.xs,
    paddingHorizontal: 4,
  },

  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.hairlineStrong,
    backgroundColor: color.surface1,
  },
  linkBtnPressed: {
    backgroundColor: color.surface2,
  },
  linkBtnLabel: {
    fontWeight: '500',
  },
  linkBtnArrow: {
    marginLeft: space.sm,
    fontSize: 16,
  },

  verifyZone: {
    marginTop: space.md,
  },
  feedbackRow: {
    minHeight: 22,
    marginTop: space.sm,
    paddingHorizontal: 4,
  },
  primaryBtn: {
    backgroundColor: color.fg,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnPressed: {
    opacity: 0.85,
  },
  primaryBtnDisabled: {
    opacity: 0.4,
  },
  primaryBtnLabel: {
    fontWeight: '600',
  },

  successZone: {
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(127,216,201,0.30)',
    backgroundColor: 'rgba(127,216,201,0.06)',
  },
  successLine: {
    fontWeight: '500',
    marginBottom: space.sm,
  },
  startBtn: {
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.hairlineStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface1,
  },
  startBtnPressed: {
    backgroundColor: color.surface2,
  },
  startBtnLabel: {
    fontWeight: '500',
  },

  // ── Connected (returning) state ───────────────────────────────────────────
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
  replaceLink: {
    alignSelf: 'flex-start',
    marginTop: space.sm,
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  replaceLinkPressed: {
    opacity: 0.5,
  },
  replaceLabel: {},
});
