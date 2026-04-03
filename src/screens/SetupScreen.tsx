import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import { useAudioPermission } from '../hooks/useAudioPermission';
import type { RootStackParamList } from '../navigation/types';
import type { PersonId, VoiceId } from '../app/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

const VOICES: { id: VoiceId; label: string; icon: string }[] = [
  { id: 'casual_male', label: 'Hombre', icon: '♂' },
  { id: 'casual_female', label: 'Mujer', icon: '♀' },
];

function VoicePicker({ personId }: { readonly personId: PersonId }): React.JSX.Element {
  const voice = useSettingsStore(s =>
    personId === 'person_a' ? s.personA.voice : s.personB.voice,
  );
  const setPersonVoice = useSettingsStore(s => s.setPersonVoice);

  return (
    <View style={pickerStyles.container}>
      <Text style={pickerStyles.prompt}>Elige tu voz</Text>
      <View style={pickerStyles.row}>
        {VOICES.map(v => {
          const active = voice === v.id;
          return (
            <Pressable
              key={v.id}
              style={[pickerStyles.btn, active && pickerStyles.btnActive]}
              onPress={() => setPersonVoice(personId, v.id)}>
              <Text style={[pickerStyles.icon, active && pickerStyles.iconActive]}>
                {v.icon}
              </Text>
              <Text style={[pickerStyles.label, active && pickerStyles.labelActive]}>
                {v.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function SetupScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const { status: micStatus, request: requestMic } = useAudioPermission();

  const handleStart = async () => {
    if (micStatus !== 'granted') {
      const granted = await requestMic();
      if (!granted) {
        Alert.alert(
          'Micrófono necesario',
          'Parly necesita acceso al micrófono para funcionar.',
          [{ text: 'OK' }],
        );
        return;
      }
    }
    navigation.replace('Conversation');
  };

  return (
    <View style={styles.container}>
      {/* Top half — rotated for person across */}
      <View style={[styles.panel, styles.topPanel, { paddingBottom: insets.top }]}>
        <View style={styles.rotated}>
          <VoicePicker personId="person_b" />
        </View>
      </View>

      {/* Center divider with start button */}
      <View style={styles.dividerWrap}>
        <View style={styles.dividerLine} />
        <Pressable style={styles.startBtn} onPress={handleStart}>
          <Text style={styles.startText}>Empezar</Text>
        </Pressable>
        <View style={styles.dividerLine} />
      </View>

      {/* Bottom half — normal for person holding phone */}
      <View style={[styles.panel, styles.bottomPanel, { paddingBottom: insets.bottom }]}>
        <VoicePicker personId="person_a" />
      </View>
    </View>
  );
}

const pickerStyles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    padding: 24,
  },
  prompt: {
    fontSize: 18,
    fontWeight: '600',
    color: '#9ca3af',
  },
  row: {
    flexDirection: 'row',
    gap: 16,
  },
  btn: {
    width: 100,
    height: 100,
    borderRadius: 20,
    backgroundColor: '#1f2937',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  btnActive: {
    borderColor: '#2563eb',
    backgroundColor: '#1e3a5f',
  },
  icon: {
    fontSize: 32,
    color: '#6b7280',
  },
  iconActive: {
    color: '#60a5fa',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6b7280',
  },
  labelActive: {
    color: '#60a5fa',
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f0f',
  },
  panel: {
    flex: 1,
  },
  topPanel: {
    backgroundColor: '#111827',
  },
  bottomPanel: {
    backgroundColor: '#111827',
  },
  rotated: {
    flex: 1,
    transform: [{ rotate: '180deg' }],
  },
  dividerWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 2,
    backgroundColor: '#374151',
  },
  startBtn: {
    backgroundColor: '#2563eb',
    borderRadius: 20,
    paddingHorizontal: 28,
    paddingVertical: 10,
  },
  startText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
});
