import React, { useCallback, useEffect, useRef } from 'react';
import {
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useModelStore } from '../store/modelStore';
import { useConversationStore } from '../store/conversationStore';
import { startVADMode, stopVADMode } from '../services/audio/VADController';
import { initModels } from '../services/models/ModelManager';
import { GlassPanel } from '../components/glass/GlassPanel';
import { BreathingDivider } from '../components/glass/BreathingDivider';
import { GlassLoadingOverlay } from '../components/shared/GlassLoadingOverlay';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

export function ConversationScreen({ navigation }: Props): React.JSX.Element {
  const whisperStatus = useModelStore(s => s.whisperStatus);
  const whisperError = useModelStore(s => s.whisperError);
  const whisperProgress = useModelStore(s => s.whisperProgress);
  const pipelineStage = useConversationStore(s => s.pipelineStage);
  const insets = useSafeAreaInsets();

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (whisperStatus === 'ready') {
      startVADMode();
    }
    return () => {
      stopVADMode();
    };
  }, [whisperStatus]);

  // Long-press (600ms) on the breathing dot → settings
  const handleDotPressIn = useCallback(() => {
    longPressTimer.current = setTimeout(() => {
      navigation.navigate('Settings');
    }, 600);
  }, [navigation]);

  const handleDotPressOut = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  if (whisperStatus === 'error') {
    return (
      <View style={styles.errorContainer}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <Text style={styles.errorTitle}>Error cargando modelo</Text>
        <Text style={styles.errorMsg}>{whisperError}</Text>
        <Pressable style={styles.retryBtn} onPress={() => void initModels()}>
          <Text style={styles.retryText}>Reintentar</Text>
        </Pressable>
      </View>
    );
  }

  if (whisperStatus !== 'ready') {
    return (
      <GlassLoadingOverlay
        status={whisperStatus}
        progress={whisperProgress}
      />
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar hidden />

      {/* Top half — person_b, rotated 180° so they read from across the table */}
      <View style={[styles.half, { paddingBottom: insets.top }]}>
        <View style={styles.rotated}>
          <GlassPanel personId="person_b" />
        </View>
      </View>

      {/* Breathing divider — audio-reactive line. Long-press opens settings. */}
      <Pressable
        onPressIn={handleDotPressIn}
        onPressOut={handleDotPressOut}
        style={styles.dotArea}
      >
        <BreathingDivider pipelineStage={pipelineStage} />
      </Pressable>

      {/* Bottom half — person_a, normal orientation */}
      <View style={[styles.half, { paddingBottom: insets.bottom }]}>
        <GlassPanel personId="person_a" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  half: {
    flex: 1,
  },
  rotated: {
    flex: 1,
    transform: [{ rotate: '180deg' }],
  },
  dotArea: {
    paddingVertical: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorContainer: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 16,
  },
  errorTitle: {
    fontSize: 15,
    fontWeight: '400',
    color: 'rgba(255,255,255,0.50)',
  },
  errorMsg: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.25)',
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  retryText: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.40)',
  },
});
