import React from 'react';
import { ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { useSettingsStore } from '../store/settingsStore';

// Phase 1 minimal. Phase 3 adds model picker, voice preview, etc.
export function SettingsScreen(): React.JSX.Element {
  const apiKey = useSettingsStore(s => s.mistralApiKey);
  const setApiKey = useSettingsStore(s => s.setMistralApiKey);

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      <Text style={s.label}>Mistral API key</Text>
      <TextInput
        value={apiKey}
        onChangeText={setApiKey}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={s.input}
        placeholder="sk-…"
        placeholderTextColor="rgba(255,255,255,0.3)"
      />
      <Text style={s.hint}>
        Se guarda cifrada en el llavero del dispositivo. Solo se transmite en
        cabeceras Authorization a api.mistral.ai.
      </Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  content: { padding: 20 },
  label: { color: 'rgba(255,255,255,0.7)', fontSize: 14, marginBottom: 8 },
  input: {
    color: '#fff',
    fontSize: 14,
    fontFamily: 'monospace',
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  hint: { color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 12, lineHeight: 18 },
});
