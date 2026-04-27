// SettingsScreen — configuration surface, with a non-technical user (Mom-
// test) onboarding flow when no API key is configured yet.
//
// First run (no key):
//   "Bienvenido" header + 3 guided steps in plain Spanish:
//     1. Open the Mistral console (Linking.openURL).
//     2. Copy the key from "Create new key".
//     3. Paste here, verify, then go back to the conversation.
//   Lower (technical) sections are HIDDEN to keep the welcome focused.
//
// Returning user (key set):
//   Compact "Conectado a Mistral" card with COMPROBAR (re-run validation)
//   and CAMBIAR CLAVE (clear → re-enter onboarding). Conversation cleanup
//   and diagnostics are revealed below.
//
// Idiomas se cambian desde la pantalla de conversación (chip pulsable
// en cada panel). El modelo de traducción está fijado a Mistral Small
// para esta build — no se ofrece selector.

import React, { useState } from 'react';
import {
  ActivityIndicator,
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
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
      keyboardShouldPersistTaps="handled">
      {/* HEADER */}
      <View style={styles.header}>
        <Text variant="caption" tone="fgGhost" style={styles.eyebrow}>
          PARLY
        </Text>
        <Text variant="displayLarge" tone="fg">
          {noKey ? 'Bienvenido' : 'Ajustes'}
        </Text>
        <Text variant="bodySmall" tone="fgFaint" style={styles.subhead}>
          {noKey
            ? 'Vamos a poner Parly en marcha en tres pasos.'
            : 'Configura la conexión y limpia el historial.'}
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
          />
        </View>
      ) : (
        <Section label="CONEXIÓN">
          <Surface style={styles.connectedCard}>
            <View style={styles.connectedRow}>
              <View style={[styles.connectedDot, { backgroundColor: color.ok }]} />
              <View style={styles.flex}>
                <Text variant="body" tone="fg">Conectado a Mistral</Text>
                <Text variant="bodySmall" tone="fgFaint">
                  Tu clave está guardada de forma segura en este dispositivo.
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
              accessibilityLabel="Comprobar conexión"
              style={({ pressed }) => [
                styles.verifyBtn,
                pressed && styles.verifyBtnPressed,
                validating && styles.verifyBtnDisabled,
              ]}>
              {validating ? (
                <ActivityIndicator color={color.fgMuted} size="small" />
              ) : (
                <Text variant="mono" tone="fgMuted">COMPROBAR</Text>
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
            accessibilityLabel="Cambiar clave"
            style={({ pressed }) => [styles.replaceLink, pressed && styles.replaceLinkPressed]}>
            <Text variant="mono" tone="fgFaint" style={styles.replaceLabel}>
              CAMBIAR CLAVE
            </Text>
          </Pressable>
        </Section>
      )}

      {/* Lower sections — hidden until the user has a working connection.
          On first run there's no history to clear and no diagnostics to
          show, and the visual silence keeps the welcome focused. */}
      {!noKey && (
        <>
          <Section label="CONVERSACIÓN">
            <Button
              label="Limpiar historial"
              variant="danger"
              onPress={onClearHistory}
            />
          </Section>

          <Section label="DIAGNÓSTICO">
            <Button
              label="Ver logs"
              variant="secondary"
              onPress={() => navigation.navigate('Logs')}
            />
          </Section>
        </>
      )}

      <Text variant="mono" tone="fgGhost" style={styles.versionTag}>
        PARLY v4.2 — DIPLOMATIC
      </Text>
    </ScrollView>
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
        VERIFICANDO…
      </Text>
    );
  }
  if (state === null) {
    return <View style={styles.keyStatus} />;
  }
  if (state.status === 'ok') {
    return (
      <Text variant="mono" tone="ok" style={styles.keyStatus}>
        ●  KEY VÁLIDA
      </Text>
    );
  }
  if (state.status === 'invalid') {
    return (
      <Text variant="mono" tone="error" style={styles.keyStatus}>
        ●  KEY RECHAZADA
      </Text>
    );
  }
  if (state.status === 'network') {
    return (
      <Text variant="mono" tone="warn" style={styles.keyStatus}>
        ●  SIN RED
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
}: OnboardingStepsProps): React.JSX.Element {
  const hasInput = apiKey.trim().length > 0;
  return (
    <View>
      <Text variant="body" tone="fgMuted" style={styles.onboardingIntro}>
        Para entender y traducir tu voz, Parly se conecta con un servicio
        de inteligencia artificial llamado Mistral. Es gratuito y solo
        necesita un correo electrónico.
      </Text>

      <Step
        number="1"
        title="Crea tu cuenta en Mistral">
        <Text variant="body" tone="fgMuted" style={styles.stepBody}>
          Pulsa el botón de abajo. Se abrirá la web de Mistral en tu
          navegador. Regístrate o inicia sesión.
        </Text>
        <Pressable
          onPress={onOpenConsole}
          accessibilityRole="button"
          accessibilityLabel="Abrir la web de Mistral"
          style={({ pressed }) => [styles.linkBtn, pressed && styles.linkBtnPressed]}>
          <Text variant="body" tone="fg" style={styles.linkBtnLabel}>
            Abrir Mistral
          </Text>
          <Text variant="body" tone="fgMuted" style={styles.linkBtnArrow}>
            ↗
          </Text>
        </Pressable>
      </Step>

      <Step
        number="2"
        title="Copia tu clave">
        <Text variant="body" tone="fgMuted" style={styles.stepBody}>
          Una vez dentro, pulsa <Text style={styles.inlineEmph}>Create new key</Text>.
          Aparecerá un código largo en pantalla — mantenlo pulsado y copia
          el texto entero.
        </Text>
      </Step>

      <Step
        number="3"
        title="Pégala aquí debajo">
        <Surface style={styles.inputCard}>
          <TextInput
            value={apiKey}
            onChangeText={onChangeKey}
            secureTextEntry={false}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={styles.input}
            placeholder="Pega aquí la clave"
            placeholderTextColor={color.fgGhost}
          />
        </Surface>
        <Text variant="bodySmall" tone="fgFaint" style={styles.tip}>
          Mantén el dedo sobre el cuadro y pulsa <Text style={styles.inlineEmph}>Pegar</Text>.
        </Text>

        {hasInput && (
          <View style={styles.verifyZone}>
            <Pressable
              onPress={onValidate}
              disabled={validating}
              accessibilityRole="button"
              accessibilityLabel="Verificar la clave"
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.primaryBtnPressed,
                validating && styles.primaryBtnDisabled,
              ]}>
              {validating ? (
                <ActivityIndicator color={color.fgInk} size="small" />
              ) : (
                <Text variant="body" tone="fgInk" style={styles.primaryBtnLabel}>
                  Verificar clave
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
              ✓  Listo. Ya puedes empezar a hablar.
            </Text>
            <Pressable
              onPress={onStart}
              accessibilityRole="button"
              accessibilityLabel="Empezar a hablar"
              style={({ pressed }) => [
                styles.startBtn,
                pressed && styles.startBtnPressed,
              ]}>
              <Text variant="body" tone="fg" style={styles.startBtnLabel}>
                Empezar a hablar  →
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
  eyebrow: {
    marginBottom: space.md,
    letterSpacing: 2.4,
  },
  subhead: {
    marginTop: space.sm,
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
    borderColor: 'rgba(124,217,160,0.30)',
    backgroundColor: 'rgba(124,217,160,0.06)',
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
  replaceLabel: {
    letterSpacing: 1.6,
  },
});
