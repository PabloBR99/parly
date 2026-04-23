import React from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import { useConversationStore } from '../store/conversationStore';
import { useNetworkStore } from '../store/networkStore';
import { resetDiscovery } from '../services/pipeline/PipelineOrchestrator';
import { LanguageSelector } from '../components/conversation/LanguageSelector';
import type { RootStackParamList } from '../navigation/types';
import type { SttTransport } from '../store/settingsStore';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const TTS_STEPS_OPTIONS = [5, 10, 15, 20] as const;

const TRANSPORT_OPTIONS: ReadonlyArray<{ value: SttTransport; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: 'Online si hay red, offline si no' },
  { value: 'online', label: 'Online', hint: 'Solo Voxtral (requiere API key)' },
  { value: 'offline', label: 'Offline', hint: 'Solo Whisper, nunca toca red' },
];

export function SettingsScreen({ navigation }: Props): React.JSX.Element {
  const autoPlay = useSettingsStore(s => s.autoPlay);
  const ttsNumSteps = useSettingsStore(s => s.ttsNumSteps);
  const setAutoPlay = useSettingsStore(s => s.setAutoPlay);
  const setTtsNumSteps = useSettingsStore(s => s.setTtsNumSteps);
  const setPersonLanguage = useSettingsStore(s => s.setPersonLanguage);
  const langA = useSettingsStore(s => s.personA.language);
  const langB = useSettingsStore(s => s.personB.language);
  const sttTransport = useSettingsStore(s => s.sttTransport);
  const setSttTransport = useSettingsStore(s => s.setSttTransport);
  const mistralApiKey = useSettingsStore(s => s.mistralApiKey);
  const setMistralApiKey = useSettingsStore(s => s.setMistralApiKey);
  const networkState = useNetworkStore(s => s.state);
  const clearConversation = useConversationStore(s => s.clearConversation);

  const handleClearConversation = () => {
    Alert.alert(
      'Borrar conversación',
      '¿Quieres eliminar todos los mensajes de la conversación actual?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Borrar',
          style: 'destructive',
          onPress: () => {
            clearConversation();
            resetDiscovery();
            navigation.goBack();
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* Idiomas — override auto-detection if needed */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Idiomas</Text>
        <Text style={styles.hint}>Se detectan automáticamente. Cambia aquí si hay errores.</Text>

        <View style={styles.row}>
          <Text style={styles.label}>Persona A (abajo)</Text>
          <LanguageSelector
            value={langA}
            onChange={code => setPersonLanguage('person_a', code)}
            lang={langA}
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.row}>
          <Text style={styles.label}>Persona B (arriba)</Text>
          <LanguageSelector
            value={langB}
            onChange={code => setPersonLanguage('person_b', code)}
            lang={langB}
          />
        </View>
      </View>

      {/* Transcripción — online/offline */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Transcripción</Text>
          <View style={[styles.netPill, styles[`netPill_${networkState}`]]}>
            <View style={[styles.netDot, styles[`netDot_${networkState}`]]} />
            <Text style={styles.netPillText}>
              {networkState === 'online' ? 'online' : networkState === 'offline' ? 'offline' : '…'}
            </Text>
          </View>
        </View>

        <View style={styles.stepsBlock}>
          <Text style={styles.label}>Modo</Text>
          <View style={styles.stepsRow}>
            {TRANSPORT_OPTIONS.map(opt => (
              <Pressable
                key={opt.value}
                style={[styles.stepBtn, sttTransport === opt.value && styles.stepBtnActive]}
                onPress={() => setSttTransport(opt.value)}>
                <Text style={[styles.stepLabel, sttTransport === opt.value && styles.stepLabelActive]}>
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.stepsHint}>
            {TRANSPORT_OPTIONS.find(o => o.value === sttTransport)?.hint ?? ''}
          </Text>
        </View>

        {sttTransport !== 'offline' && (
          <>
            <View style={styles.divider} />
            <View style={styles.keyBlock}>
              <Text style={styles.label}>Mistral API key</Text>
              <Text style={styles.hint}>Necesaria para Voxtral. Se guarda cifrada en el keychain del dispositivo.</Text>
              <TextInput
                style={styles.keyInput}
                value={mistralApiKey}
                onChangeText={setMistralApiKey}
                placeholder="sk-…"
                placeholderTextColor="rgba(255,255,255,0.20)"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
            </View>
          </>
        )}
      </View>

      {/* TTS */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Síntesis de voz</Text>

        <View style={styles.row}>
          <View style={styles.rowLabel}>
            <Text style={styles.label}>Reproducir automáticamente</Text>
            <Text style={styles.hint}>Reproduce el audio traducido al terminar</Text>
          </View>
          <Switch
            value={autoPlay}
            onValueChange={setAutoPlay}
            trackColor={{ false: '#222222', true: 'rgba(255,255,255,0.40)' }}
            thumbColor="#ffffff"
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.stepsBlock}>
          <Text style={styles.label}>Calidad de voz (pasos)</Text>
          <Text style={styles.hint}>Más pasos = mayor calidad, mayor latencia</Text>
          <View style={styles.stepsRow}>
            {TTS_STEPS_OPTIONS.map(steps => (
              <Pressable
                key={steps}
                style={[styles.stepBtn, ttsNumSteps === steps && styles.stepBtnActive]}
                onPress={() => setTtsNumSteps(steps)}>
                <Text style={[styles.stepLabel, ttsNumSteps === steps && styles.stepLabelActive]}>
                  {steps}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.stepsHint}>
            {ttsNumSteps <= 5 ? 'Rápido (~0.5s)' :
             ttsNumSteps <= 10 ? 'Equilibrado (~1s)' :
             ttsNumSteps <= 15 ? 'Alta calidad (~1.5s)' :
             'Máxima calidad (~2s)'}
          </Text>
        </View>
      </View>

      {/* Conversación */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Conversación</Text>

        <Pressable style={styles.dangerBtn} onPress={handleClearConversation}>
          <Text style={styles.dangerBtnText}>Borrar mensajes</Text>
        </Pressable>
      </View>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  content: {
    padding: 20,
    gap: 20,
    paddingBottom: 48,
  },
  section: {
    backgroundColor: '#0d0d0d',
    borderRadius: 16,
    padding: 20,
    gap: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.30)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  netPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  netPill_online: {
    backgroundColor: 'rgba(34,197,94,0.10)',
  },
  netPill_offline: {
    backgroundColor: 'rgba(250,204,21,0.10)',
  },
  netPill_unknown: {
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  netDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.30)',
  },
  netDot_online: {
    backgroundColor: '#22c55e',
  },
  netDot_offline: {
    backgroundColor: '#facc15',
  },
  netDot_unknown: {
    backgroundColor: 'rgba(255,255,255,0.30)',
  },
  netPillText: {
    fontSize: 10,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.60)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  keyBlock: {
    gap: 8,
  },
  keyInput: {
    backgroundColor: '#161616',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: 'rgba(255,255,255,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    fontFamily: 'monospace',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowLabel: {
    flex: 1,
    gap: 2,
  },
  label: {
    fontSize: 15,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.85)',
  },
  hint: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.25)',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  stepsBlock: {
    gap: 8,
  },
  stepsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  stepBtn: {
    flex: 1,
    backgroundColor: '#161616',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  stepBtnActive: {
    borderColor: 'rgba(255,255,255,0.40)',
    backgroundColor: '#1a1a1a',
  },
  stepLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.30)',
  },
  stepLabelActive: {
    color: 'rgba(255,255,255,0.92)',
  },
  stepsHint: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.25)',
    textAlign: 'center',
  },
  dangerBtn: {
    backgroundColor: '#1a0000',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(220,38,38,0.40)',
  },
  dangerBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: 'rgba(220,38,38,0.70)',
  },
});
