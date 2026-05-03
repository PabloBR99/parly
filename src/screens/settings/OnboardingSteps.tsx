import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import type { KeyValidation } from '../../services/auth/validateApiKey';
import { KeyValidationLine } from './KeyValidationLine';
import { Surface, Text, color, radius, space } from '../../ui';

// ── Step ────────────────────────────────────────────────────────────────────

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

// ── OnboardingSteps ─────────────────────────────────────────────────────────

export interface OnboardingStepsProps {
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

export function OnboardingSteps({
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
            secureTextEntry
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

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
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
    paddingLeft: 28 + space.sm,
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
});
