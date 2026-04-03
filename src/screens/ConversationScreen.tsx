import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useModelStore } from '../store/modelStore';
import { useSettingsStore } from '../store/settingsStore';
import { initModels } from '../services/models/ModelManager';
import { startVADMode, stopVADMode } from '../services/audio/VADController';
import { SplitScreenLayout } from '../components/conversation/SplitScreenLayout';
import { PersonPanel } from '../components/conversation/PersonPanel';
import { LoadingOverlay } from '../components/shared/LoadingOverlay';

export function ConversationScreen(): React.JSX.Element {
  const whisperStatus = useModelStore(s => s.whisperStatus);
  const zipvoiceStatus = useModelStore(s => s.zipvoiceStatus);
  const whisperProgress = useModelStore(s => s.whisperProgress);
  const zipvoiceProgress = useModelStore(s => s.zipvoiceProgress);
  const whisperError = useModelStore(s => s.whisperError);
  const inputMode = useSettingsStore(s => s.inputMode);
  const setInputMode = useSettingsStore(s => s.setInputMode);

  const toggleMode = useCallback(() => {
    if (inputMode === 'ptt') {
      setInputMode('vad');
      startVADMode();
    } else {
      stopVADMode();
      setInputMode('ptt');
    }
  }, [inputMode, setInputMode]);

  if (whisperStatus === 'error') {
    return (
      <View style={styles.error}>
        <Text style={styles.errorTitle}>Error cargando modelo STT</Text>
        <Text style={styles.errorMsg}>{whisperError}</Text>
        <Pressable style={styles.retryBtn} onPress={() => void initModels()}>
          <Text style={styles.retryTxt}>Reintentar</Text>
        </Pressable>
      </View>
    );
  }

  if (whisperStatus !== 'ready') {
    return (
      <LoadingOverlay
        whisperStatus={whisperStatus}
        zipvoiceStatus={zipvoiceStatus}
        whisperProgress={whisperProgress}
        zipvoiceProgress={zipvoiceProgress}
      />
    );
  }

  return (
    <SafeAreaProvider>
      <View style={styles.container}>
        <SplitScreenLayout
          topPanel={<PersonPanel personId="person_b" inverted />}
          bottomPanel={<PersonPanel personId="person_a" />}
        />
        {/* Mode toggle — floating pill on the divider */}
        <View style={styles.modeToggleWrap}>
          <Pressable style={styles.modeToggle} onPress={toggleMode}>
            <Text style={styles.modeToggleText}>
              {inputMode === 'ptt' ? 'PTT' : 'AUTO'}
            </Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f0f',
  },
  error: {
    flex: 1,
    backgroundColor: '#0f0f0f',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 16,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#f87171',
  },
  errorMsg: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
  },
  retryBtn: {
    backgroundColor: '#2563eb',
    borderRadius: 12,
    paddingHorizontal: 32,
    paddingVertical: 14,
  },
  retryTxt: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
  modeToggleWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    alignItems: 'center',
    zIndex: 10,
  },
  modeToggle: {
    backgroundColor: '#1f2937',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#374151',
  },
  modeToggleText: {
    color: '#9ca3af',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
