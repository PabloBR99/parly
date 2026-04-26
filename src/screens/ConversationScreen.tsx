import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

// Phase 1 placeholder. Phase 3 replaces this with the two-half UI + PTT mics.
export function ConversationScreen({ navigation }: Props): React.JSX.Element {
  const personA = useSettingsStore(s => s.personA);
  const personB = useSettingsStore(s => s.personB);
  return (
    <View style={s.root}>
      <Text style={s.label}>
        {personB.language || '—'}  ⇄  {personA.language || '—'}
      </Text>
      <Pressable style={s.link} onPress={() => navigation.navigate('Settings')}>
        <Text style={s.linkLabel}>Ajustes</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  label: { color: '#fff', fontSize: 18 },
  link: { marginTop: 24, paddingHorizontal: 16, paddingVertical: 10 },
  linkLabel: { color: 'rgba(255,255,255,0.6)' },
});
