import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { ProgressBar } from './ProgressBar';

import type { ModelStatus } from '../../app/types';

interface Props {
  readonly whisperStatus: ModelStatus;
  readonly zipvoiceStatus: ModelStatus;
  readonly whisperProgress: number;
  readonly zipvoiceProgress: number;
}

export function LoadingOverlay({
  whisperStatus,
  zipvoiceStatus,
  whisperProgress,
  zipvoiceProgress,
}: Props): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Cargando modelos</Text>
      <Text style={styles.subtitle}>Primera vez puede tardar varios minutos</Text>

      <View style={styles.model}>
        <Text style={styles.modelName}>Whisper STT</Text>
        <Text style={styles.modelStatus}>{statusLabel(whisperStatus)}</Text>
        {whisperStatus === 'downloading' && (
          <ProgressBar progress={whisperProgress} />
        )}
        {(whisperStatus === 'loading' || whisperStatus === 'downloading') && (
          <ActivityIndicator color="#2563eb" style={styles.spinner} />
        )}
      </View>

      <View style={styles.model}>
        <Text style={styles.modelName}>ZipVoice TTS</Text>
        <Text style={styles.modelStatus}>{statusLabel(zipvoiceStatus)}</Text>
        {zipvoiceStatus === 'downloading' && (
          <ProgressBar progress={zipvoiceProgress} />
        )}
        {(zipvoiceStatus === 'loading' || zipvoiceStatus === 'downloading') && (
          <ActivityIndicator color="#2563eb" style={styles.spinner} />
        )}
        {zipvoiceStatus === 'error' && (
          <Text style={styles.fallback}>Usando TTS del sistema</Text>
        )}
      </View>
    </View>
  );
}

function statusLabel(status: ModelStatus): string {
  switch (status) {
    case 'not_downloaded': return 'Pendiente';
    case 'downloading': return 'Descargando…';
    case 'loading': return 'Cargando en memoria…';
    case 'ready': return 'Listo ✓';
    case 'error': return 'Omitido';
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f0f',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#f9fafb',
  },
  subtitle: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
  },
  model: {
    width: '100%',
    backgroundColor: '#1f2937',
    borderRadius: 16,
    padding: 20,
    gap: 8,
  },
  modelName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#f9fafb',
  },
  modelStatus: {
    fontSize: 14,
    color: '#9ca3af',
  },
  spinner: {
    marginTop: 4,
  },
  fallback: {
    fontSize: 12,
    color: '#f59e0b',
  },
});
