import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'LanguagePair'>;

// Phase 1 placeholder. Phase 3 replaces this with the Handoff UX.
export function LanguagePairScreen({ navigation }: Props): React.JSX.Element {
  const setPersonLanguage = useSettingsStore(s => s.setPersonLanguage);
  const setLanguagePairConfigured = useSettingsStore(s => s.setLanguagePairConfigured);

  const continueWith = (a: string, b: string) => {
    setPersonLanguage('A', a);
    setPersonLanguage('B', b);
    setLanguagePairConfigured(true);
    navigation.replace('Conversation');
  };

  return (
    <View style={s.root}>
      <Text style={s.title}>Selección de idiomas</Text>
      <Text style={s.subtitle}>(placeholder — UX completa en Phase 3)</Text>
      <Pressable style={s.btn} onPress={() => continueWith('es', 'en')}>
        <Text style={s.btnLabel}>Continuar  ES ⇄ EN</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: '#fff', fontSize: 22, marginBottom: 6 },
  subtitle: { color: 'rgba(255,255,255,0.4)', fontSize: 13, marginBottom: 32 },
  btn: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.08)' },
  btnLabel: { color: '#fff', fontSize: 16 },
});
