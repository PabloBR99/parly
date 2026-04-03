import React from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import { LanguageSelector } from '../components/conversation/LanguageSelector';
import { useAudioPermission } from '../hooks/useAudioPermission';
import type { RootStackParamList } from '../navigation/types';
import type { VoiceId } from '../app/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

const VOICES: { id: VoiceId; label: string; icon: string }[] = [
  { id: 'casual_male', label: 'Hombre', icon: '👨' },
  { id: 'casual_female', label: 'Mujer', icon: '👩' },
];

export function SetupScreen({ navigation }: Props): React.JSX.Element {
  const { personA, personB, setPersonLanguage, setPersonVoice } = useSettingsStore();
  const { status: micStatus, request: requestMic } = useAudioPermission();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Configuración</Text>
      <Text style={styles.subtitle}>Cada persona elige su idioma y voz</Text>

      {(['person_a', 'person_b'] as const).map(personId => {
        const config = personId === 'person_a' ? personA : personB;
        const label = personId === 'person_a' ? 'Persona 1 (abajo)' : 'Persona 2 (arriba)';
        return (
          <View key={personId} style={styles.card}>
            <Text style={styles.cardTitle}>{label}</Text>

            <Text style={styles.fieldLabel}>Idioma</Text>
            <LanguageSelector
              value={config.language}
              onChange={code => setPersonLanguage(personId, code)}
            />

            <Text style={styles.fieldLabel}>Voz</Text>
            <View style={styles.voiceRow}>
              {VOICES.map(v => (
                <Pressable
                  key={v.id}
                  style={[styles.voiceBtn, config.voice === v.id && styles.voiceBtnActive]}
                  onPress={() => setPersonVoice(personId, v.id)}>
                  <Text style={styles.voiceIcon}>{v.icon}</Text>
                  <Text style={[styles.voiceLabel, config.voice === v.id && styles.voiceLabelActive]}>
                    {v.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}

      <Pressable
        style={styles.startBtn}
        onPress={async () => {
          if (micStatus !== 'granted') {
            const granted = await requestMic();
            if (!granted) {
              Alert.alert(
                'Micrófono necesario',
                'LinguaFace necesita acceso al micrófono para funcionar.',
                [{ text: 'OK' }],
              );
              return;
            }
          }
          navigation.replace('Conversation');
        }}>
        <Text style={styles.startBtnText}>Iniciar conversación</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f' },
  content: { padding: 24, gap: 16, paddingBottom: 48 },
  title: { fontSize: 28, fontWeight: '700', color: '#f9fafb' },
  subtitle: { fontSize: 15, color: '#6b7280' },
  card: {
    backgroundColor: '#1f2937',
    borderRadius: 16,
    padding: 20,
    gap: 10,
  },
  cardTitle: { fontSize: 16, fontWeight: '600', color: '#f9fafb' },
  fieldLabel: { fontSize: 13, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 },
  voiceRow: { flexDirection: 'row', gap: 10 },
  voiceBtn: {
    flex: 1,
    backgroundColor: '#374151',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    gap: 6,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  voiceBtnActive: { borderColor: '#2563eb', backgroundColor: '#1e3a5f' },
  voiceIcon: { fontSize: 28 },
  voiceLabel: { fontSize: 13, color: '#9ca3af', textAlign: 'center' },
  voiceLabelActive: { color: '#60a5fa' },
  startBtn: {
    backgroundColor: '#2563eb',
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 8,
  },
  startBtnText: { fontSize: 17, fontWeight: '700', color: '#fff' },
});
