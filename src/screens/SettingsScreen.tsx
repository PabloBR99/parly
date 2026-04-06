import React from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import { useConversationStore } from '../store/conversationStore';
import { resetDiscovery } from '../services/pipeline/PipelineOrchestrator';
import { LanguageSelector } from '../components/conversation/LanguageSelector';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const TTS_STEPS_OPTIONS = [5, 10, 15, 20] as const;

export function SettingsScreen({ navigation }: Props): React.JSX.Element {
  const autoPlay = useSettingsStore(s => s.autoPlay);
  const ttsNumSteps = useSettingsStore(s => s.ttsNumSteps);
  const setAutoPlay = useSettingsStore(s => s.setAutoPlay);
  const setTtsNumSteps = useSettingsStore(s => s.setTtsNumSteps);
  const setPersonLanguage = useSettingsStore(s => s.setPersonLanguage);
  const langA = useSettingsStore(s => s.personA.language);
  const langB = useSettingsStore(s => s.personB.language);
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
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.30)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
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
