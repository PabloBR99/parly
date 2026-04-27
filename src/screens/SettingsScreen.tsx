// SettingsScreen — minimal configuration surface.
//
// Sections:
//   1. API key (kept in keychain, only sent to api.mistral.ai). Includes
//      a one-tap validator that hits GET /v1/models.
//   2. Conversation — clear history.
//   3. Diagnóstico — log viewer (temporary, slated for removal).
//
// Idiomas se cambian desde la pantalla de conversación (chip pulsable
// en cada panel). El modelo de traducción está fijado a Mistral Small
// para esta build — no se ofrece selector.

import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import { useConversationStore } from '../store/conversationStore';
import { validateMistralApiKey, type KeyValidation } from '../services/auth/validateApiKey';
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
          Ajustes
        </Text>
        <Text variant="bodySmall" tone="fgFaint" style={styles.subhead}>
          Configura la conexión y limpia el historial.
        </Text>
      </View>

      {/* API KEY */}
      <Section label="MISTRAL API KEY">
        <Surface style={styles.inputCard}>
          <TextInput
            value={apiKey}
            onChangeText={(v) => {
              setApiKey(v);
              setKeyValidation(null);
            }}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            placeholder="Pega tu key de Mistral"
            placeholderTextColor={color.fgGhost}
          />
        </Surface>
        <View style={styles.keyActionRow}>
          <KeyValidationLine state={keyValidation} validating={validating} />
          <Pressable
            onPress={onValidateKey}
            disabled={validating || apiKey.trim().length === 0}
            accessibilityRole="button"
            accessibilityLabel="Verificar API key"
            style={({ pressed }) => [
              styles.verifyBtn,
              pressed && styles.verifyBtnPressed,
              (validating || apiKey.trim().length === 0) && styles.verifyBtnDisabled,
            ]}>
            {validating ? (
              <ActivityIndicator color={color.fgMuted} size="small" />
            ) : (
              <Text variant="mono" tone="fgMuted">VERIFICAR</Text>
            )}
          </Pressable>
        </View>
        <Text variant="bodySmall" tone="fgFaint" style={styles.hint}>
          Pégala tal cual te la dio Mistral —{' '}
          <Text variant="bodySmall" tone="fgMuted" style={styles.mono}>sin</Text>{' '}
          prefijo "sk-". Se cifra en el llavero del dispositivo y solo
          viaja en la cabecera{' '}
          <Text variant="bodySmall" tone="fgMuted" style={styles.mono}>Authorization</Text>{' '}
          a api.mistral.ai.
        </Text>
      </Section>

      {/* CONVERSATION */}
      <Section label="CONVERSACIÓN">
        <Button
          label="Limpiar historial"
          variant="danger"
          onPress={onClearHistory}
        />
      </Section>

      {/* DIAGNOSTIC */}
      <Section label="DIAGNÓSTICO">
        <Button
          label="Ver logs"
          variant="secondary"
          onPress={() => navigation.navigate('Logs')}
        />
      </Section>

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
});
