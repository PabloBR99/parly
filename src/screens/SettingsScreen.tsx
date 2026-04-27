// SettingsScreen — refined configuration surface.
//
// Sections:
//   1. API key (kept in keychain, only sent to api.mistral.ai).
//   2. Translation model picker (3 options).
//   3. Languages — current pair + voice preview + re-pick action.
//   4. Conversation — clear history.
//
// Visual: same dark editorial language as the rest of the app. Sections
// are titled in mono uppercase microcopy; rows live inside Surface cards.

import React from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import {
  useSettingsStore,
  TRANSLATION_MODELS,
  type TranslationModelId,
} from '../store/settingsStore';
import { useConversationStore } from '../store/conversationStore';
import { nativeTTSService } from '../services/tts/NativeTTSService';
import { getLanguage } from '../app/languages';
import type { RootStackParamList } from '../navigation/types';
import {
  Button,
  Surface,
  Text,
  color,
  haptics,
  motion,
  radius,
  space,
} from '../ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export function SettingsScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const apiKey = useSettingsStore(s => s.mistralApiKey);
  const setApiKey = useSettingsStore(s => s.setMistralApiKey);
  const translationModel = useSettingsStore(s => s.translationModel);
  const setTranslationModel = useSettingsStore(s => s.setTranslationModel);
  const personA = useSettingsStore(s => s.personA);
  const personB = useSettingsStore(s => s.personB);
  const resetLanguagePair = useSettingsStore(s => s.resetLanguagePair);
  const setLanguagePairConfigured = useSettingsStore(s => s.setLanguagePairConfigured);
  const clearConversation = useConversationStore(s => s.clear);

  const langA = personA.language ? getLanguage(personA.language) : null;
  const langB = personB.language ? getLanguage(personB.language) : null;

  const previewVoice = (langCode: string, sample: string) => {
    haptics.tap();
    void nativeTTSService.speakChunk(sample, langCode).catch(() => {});
  };

  const repickLanguages = () => {
    resetLanguagePair();
    setLanguagePairConfigured(false);
    navigation.replace('LanguagePair');
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
          PARLY  ·  AJUSTES
        </Text>
        <Text variant="displayLarge" tone="fg">
          Configuración
        </Text>
      </View>

      {/* API KEY */}
      <Section label="MISTRAL API KEY">
        <Surface style={styles.inputCard}>
          <TextInput
            value={apiKey}
            onChangeText={setApiKey}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            placeholder="Pega tu key de Mistral"
            placeholderTextColor={color.fgGhost}
          />
        </Surface>
        <Text variant="bodySmall" tone="fgFaint" style={styles.hint}>
          Pégala tal cual te la dio Mistral —{' '}
          <Text variant="bodySmall" tone="fgMuted" style={styles.mono}>sin</Text>{' '}
          prefijo "sk-". Se cifra en el llavero del dispositivo y solo
          viaja en la cabecera{' '}
          <Text variant="bodySmall" tone="fgMuted" style={styles.mono}>Authorization</Text>{' '}
          a api.mistral.ai.
        </Text>
      </Section>

      {/* MODEL */}
      <Section label="MODELO DE TRADUCCIÓN">
        <Surface style={styles.list}>
          {TRANSLATION_MODELS.map((m, idx) => (
            <ModelOption
              key={m.id}
              id={m.id}
              label={m.label}
              selected={translationModel === m.id}
              isLast={idx === TRANSLATION_MODELS.length - 1}
              onPress={() => {
                haptics.tick();
                setTranslationModel(m.id);
              }}
            />
          ))}
        </Surface>
      </Section>

      {/* LANGUAGES */}
      <Section label="IDIOMAS">
        <Surface style={styles.langCard}>
          <View style={styles.langRow}>
            <LanguageSlot
              label="OTRO"
              accent={color.accentB}
              language={langB}
              onPreview={langB ? () => previewVoice(langB.code, sampleFor(langB.code)) : undefined}
            />
            <View style={styles.langDivider} />
            <LanguageSlot
              label="TÚ"
              accent={color.accentA}
              language={langA}
              onPreview={langA ? () => previewVoice(langA.code, sampleFor(langA.code)) : undefined}
            />
          </View>
          <Button
            label="Cambiar idiomas"
            variant="secondary"
            onPress={repickLanguages}
            style={styles.langCta}
          />
        </Surface>
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
        PARLY v4.1 — DIPLOMATIC
      </Text>
    </ScrollView>
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

// ── Model option (animated radio) ────────────────────────────────────────────

interface ModelOptionProps {
  readonly id: TranslationModelId;
  readonly label: string;
  readonly selected: boolean;
  readonly isLast: boolean;
  readonly onPress: () => void;
}

function ModelOption({
  id, label, selected, isLast, onPress,
}: ModelOptionProps): React.JSX.Element {
  const fillScale = useSharedValue(selected ? 1 : 0);
  React.useEffect(() => {
    fillScale.value = withSpring(selected ? 1 : 0, motion.springSnappy);
  }, [selected, fillScale]);

  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ scale: fillScale.value }],
    opacity: fillScale.value,
  }));

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}>
      <View style={[styles.modelOpt, !isLast && styles.modelOptDivider]}>
        <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
          <Animated.View style={[styles.radioInner, fillStyle]} />
        </View>
        <View style={styles.modelLabelStack}>
          <Text variant="body" tone={selected ? 'fg' : 'fgMuted'}>{label}</Text>
        </View>
        <Text variant="mono" tone="fgGhost">{id}</Text>
      </View>
    </Pressable>
  );
}

// ── Language slot ────────────────────────────────────────────────────────────

interface LanguageSlotProps {
  readonly label: string;
  readonly accent: string;
  readonly language: ReturnType<typeof getLanguage> | null;
  readonly onPreview?: () => void;
}

function LanguageSlot({ label, accent, language, onPreview }: LanguageSlotProps): React.JSX.Element {
  return (
    <View style={styles.langSlot}>
      <View style={styles.langSlotHeader}>
        <View style={[styles.langSlotDot, { backgroundColor: language ? accent : color.fgGhost }]} />
        <Text variant="caption" tone="fgFaint">{label}</Text>
      </View>
      <Text variant="display" tone={language ? 'fg' : 'fgGhost'} style={styles.langSlotEndonym}>
        {language ? language.endonym : '—'}
      </Text>
      {language && (
        <View style={styles.langSlotMeta}>
          <Text variant="bodySmall" tone="fgFaint">{language.emoji}  {language.name}</Text>
          {onPreview && (
            <Pressable
              onPress={onPreview}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Probar voz de ${language.name}`}>
              <Text variant="mono" tone="fgMuted" style={styles.previewLink}>PROBAR ▷</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sampleFor(langCode: string): string {
  const samples: Record<string, string> = {
    en: 'Welcome.',
    es: 'Bienvenido.',
    fr: 'Bienvenue.',
    de: 'Willkommen.',
    it: 'Benvenuto.',
    pt: 'Bem-vindo.',
    nl: 'Welkom.',
    ru: 'Добро пожаловать.',
    uk: 'Ласкаво просимо.',
    pl: 'Witamy.',
    cs: 'Vítejte.',
    el: 'Καλώς ήρθατε.',
    tr: 'Hoş geldiniz.',
    ar: 'أهلاً وسهلاً.',
    he: 'ברוך הבא.',
    fa: 'خوش آمدید.',
    hi: 'स्वागत है.',
    bn: 'স্বাগতম।',
    ur: 'خوش آمدید۔',
    zh: '欢迎。',
    ja: 'ようこそ。',
    ko: '환영합니다.',
    vi: 'Xin chào.',
    th: 'ยินดีต้อนรับ',
    id: 'Selamat datang.',
    sv: 'Välkommen.',
    no: 'Velkommen.',
    da: 'Velkommen.',
    fi: 'Tervetuloa.',
    ro: 'Bun venit.',
    hu: 'Üdvözlöm.',
    sw: 'Karibu.',
  };
  return samples[langCode.toLowerCase()] ?? 'Welcome.';
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: {
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
  },

  header: {
    paddingBottom: space.xl,
  },
  eyebrow: {
    marginBottom: space.xs,
  },

  section: {
    marginBottom: space.xxl,
  },
  sectionLabel: {
    marginBottom: space.sm,
  },
  sectionBody: {},

  inputCard: {
    paddingVertical: 4,
  },
  input: {
    color: color.fg,
    fontSize: 14,
    fontFamily: undefined,
    paddingHorizontal: space.sm,
    paddingVertical: 10,
  },
  hint: {
    marginTop: space.xs,
    paddingHorizontal: 4,
    lineHeight: 19,
  },
  mono: {
    fontFamily: 'monospace',
  },

  list: {
    padding: 0,
  },
  modelOpt: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.md,
    paddingHorizontal: space.md,
  },
  modelOptDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  radioOuter: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: color.fgGhost,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: space.sm,
  },
  radioOuterSelected: {
    borderColor: color.fg,
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: color.fg,
  },
  modelLabelStack: {
    flex: 1,
  },

  langCard: {
    paddingVertical: space.md,
  },
  langRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginBottom: space.md,
  },
  langDivider: {
    width: StyleSheet.hairlineWidth,
    marginHorizontal: space.sm,
    backgroundColor: color.hairline,
  },
  langSlot: {
    flex: 1,
    paddingHorizontal: 4,
  },
  langSlotHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: space.xs,
  },
  langSlotDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: space.xs,
  },
  langSlotEndonym: {
    marginBottom: space.xs,
  },
  langSlotMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  previewLink: {
    paddingVertical: 4,
  },
  langCta: {
    alignSelf: 'stretch',
  },

  versionTag: {
    textAlign: 'center',
    marginTop: space.lg,
    opacity: 0.45,
  },
});
