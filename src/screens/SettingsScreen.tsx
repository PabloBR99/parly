// SettingsScreen — slim, embassy-friendly.
//
// What lives here:
//   - Mistral API key (kept in keychain; only ever transmitted in the
//     Authorization header to api.mistral.ai)
//   - Translation model picker (default mistral-small-latest)
//   - Re-pick languages (returns to LanguagePairScreen)
//   - Voice preview per side
//   - "Limpiar conversación" — clears the on-screen history
//
// What does NOT live here:
//   - Anything about on-device models — there are none in v4
//   - VAD vs PTT selector — PTT only, by design (more reliable)

import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  useSettingsStore,
  TRANSLATION_MODELS,
  type TranslationModelId,
} from '../store/settingsStore';
import { useConversationStore } from '../store/conversationStore';
import { nativeTTSService } from '../services/tts/NativeTTSService';
import { getLanguage } from '../app/languages';
import type { RootStackParamList } from '../navigation/types';

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
    void nativeTTSService.speakChunk(sample, langCode).catch(() => {});
  };

  const repickLanguages = () => {
    resetLanguagePair();
    setLanguagePairConfigured(false);
    navigation.replace('LanguagePair');
  };

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      keyboardShouldPersistTaps="handled">

      {/* API KEY */}
      <Section title="Mistral API key">
        <TextInput
          value={apiKey}
          onChangeText={setApiKey}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          placeholder="sk-…"
          placeholderTextColor="rgba(255,255,255,0.30)"
        />
        <Text style={styles.hint}>
          Se cifra en el llavero del dispositivo. Solo viaja en la cabecera
          Authorization a api.mistral.ai.
        </Text>
      </Section>

      {/* MODEL */}
      <Section title="Modelo de traducción">
        {TRANSLATION_MODELS.map((m) => (
          <ModelOption
            key={m.id}
            id={m.id}
            label={m.label}
            selected={translationModel === m.id}
            onPress={() => setTranslationModel(m.id)}
          />
        ))}
      </Section>

      {/* LANGUAGES */}
      <Section title="Idiomas">
        <View style={styles.langRow}>
          <View style={styles.langCol}>
            <Text style={styles.langLabel}>Persona en frente</Text>
            <Text style={styles.langValue}>
              {langB ? `${langB.emoji}  ${langB.endonym}` : '—'}
            </Text>
            {langB && (
              <Pressable
                style={styles.previewBtn}
                onPress={() => previewVoice(langB.code, sampleFor(langB.code))}>
                <Text style={styles.previewLabel}>Probar voz</Text>
              </Pressable>
            )}
          </View>
          <View style={styles.langCol}>
            <Text style={styles.langLabel}>Tú</Text>
            <Text style={styles.langValue}>
              {langA ? `${langA.emoji}  ${langA.endonym}` : '—'}
            </Text>
            {langA && (
              <Pressable
                style={styles.previewBtn}
                onPress={() => previewVoice(langA.code, sampleFor(langA.code))}>
                <Text style={styles.previewLabel}>Probar voz</Text>
              </Pressable>
            )}
          </View>
        </View>
        <Pressable style={styles.actionBtn} onPress={repickLanguages}>
          <Text style={styles.actionLabel}>Cambiar idiomas</Text>
        </Pressable>
      </Section>

      {/* CONVERSATION */}
      <Section title="Conversación">
        <Pressable
          style={styles.actionBtnDanger}
          onPress={() => {
            clearConversation();
            navigation.goBack();
          }}>
          <Text style={styles.actionLabelDanger}>Limpiar historial</Text>
        </Pressable>
      </Section>

      <Text style={styles.versionTag}>Parly v4.0</Text>
    </ScrollView>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function ModelOption({
  id, label, selected, onPress,
}: {
  readonly id: TranslationModelId;
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      style={[styles.modelOpt, selected && styles.modelOptSelected]}
      onPress={onPress}>
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected && <View style={styles.radioInner} />}
      </View>
      <Text style={[styles.modelLabel, selected && styles.modelLabelSelected]}>
        {label}
      </Text>
      <Text style={styles.modelId}>{id}</Text>
    </Pressable>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sampleFor(langCode: string): string {
  // Short greeting. Native script where available.
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

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  content: { padding: 20 },

  section: { marginBottom: 28 },
  sectionTitle: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 11,
    letterSpacing: 1.2,
    marginBottom: 10,
  },
  sectionBody: {},

  input: {
    color: '#fff',
    fontSize: 14,
    fontFamily: 'monospace',
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  hint: { color: 'rgba(255,255,255,0.40)', fontSize: 12, marginTop: 8, lineHeight: 18 },

  modelOpt: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    marginBottom: 8,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  modelOptSelected: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderColor: 'rgba(255,255,255,0.16)',
  },
  radio: {
    width: 18, height: 18, borderRadius: 9,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.30)',
    marginRight: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  radioSelected: { borderColor: 'rgba(255,255,255,0.85)' },
  radioInner: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
  modelLabel: { color: 'rgba(255,255,255,0.65)', fontSize: 14, flex: 1 },
  modelLabelSelected: { color: 'rgba(255,255,255,0.95)' },
  modelId: { color: 'rgba(255,255,255,0.30)', fontSize: 10, fontFamily: 'monospace' },

  langRow: { flexDirection: 'row', marginBottom: 12 },
  langCol: { flex: 1, paddingRight: 8 },
  langLabel: { color: 'rgba(255,255,255,0.45)', fontSize: 11, letterSpacing: 0.6 },
  langValue: { color: 'rgba(255,255,255,0.92)', fontSize: 16, marginTop: 2 },
  previewBtn: {
    alignSelf: 'flex-start',
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  previewLabel: { color: 'rgba(255,255,255,0.65)', fontSize: 11, letterSpacing: 0.5 },

  actionBtn: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  actionLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '500' },

  actionBtnDanger: {
    backgroundColor: 'rgba(248,113,113,0.06)',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.18)',
  },
  actionLabelDanger: { color: 'rgba(252,165,165,0.95)', fontSize: 14, fontWeight: '500' },

  versionTag: {
    color: 'rgba(255,255,255,0.20)',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 12,
  },
});
