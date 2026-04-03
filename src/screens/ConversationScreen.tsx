import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { startVADMode, stopVADMode } from '../services/audio/VADController';
import { initModels } from '../services/models/ModelManager';
import { GlassPanel } from '../components/glass/GlassPanel';
import { BreathingDivider } from '../components/glass/BreathingDivider';
import { HistorySheet } from '../components/glass/HistorySheet';
import { GlassLoadingOverlay } from '../components/shared/GlassLoadingOverlay';
import { useConversationStore } from '../store/conversationStore';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

export function ConversationScreen({ navigation }: Props): React.JSX.Element {
  const whisperStatus = useModelStore(s => s.whisperStatus);
  const whisperError = useModelStore(s => s.whisperError);
  const whisperProgress = useModelStore(s => s.whisperProgress);
  const activeSpeaker = useConversationStore(s => s.activeSpeaker);
  const pipelineStage = useConversationStore(s => s.pipelineStage);
  const insets = useSafeAreaInsets();

  const [historyVisible, setHistoryVisible] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-start VAD when models are ready
  useEffect(() => {
    if (whisperStatus === 'ready') {
      startVADMode();
    }
    return () => {
      stopVADMode();
    };
  }, [whisperStatus]);

  const handleDividerPressIn = useCallback(() => {
    // Long-press (600ms) on divider → open settings
    longPressTimer.current = setTimeout(() => {
      navigation.navigate('Settings');
    }, 600);
  }, [navigation]);

  const handleDividerPressOut = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Loading / error states
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
      <StatusBar barStyle="light-content" backgroundColor="#000" />

      {/* Top half — person_b, rotated 180° so they read from across the table */}
      <View
        style={[
          styles.half,
          styles.topHalf,
          { paddingBottom: insets.top },
        ]}
      >
        <View style={styles.rotated}>
          <GlassPanel personId="person_b" />
        </View>
      </View>

      {/* Breathing divider — long-press opens settings */}
      <Pressable
        onPressIn={handleDividerPressIn}
        onPressOut={handleDividerPressOut}
        style={styles.dividerArea}
      >
        <BreathingDivider
          activeSpeaker={activeSpeaker}
          pipelineStage={pipelineStage}
        />
      </Pressable>

      {/* Bottom half — person_a, normal orientation */}
      <View
        style={[
          styles.half,
          styles.bottomHalf,
          { paddingBottom: insets.bottom },
        ]}
      >
        <GlassPanel personId="person_a" />
      </View>

      {/* Swipe-up history hint */}
      <Pressable
        style={styles.historyHint}
        onPress={() => setHistoryVisible(true)}
      >
        <Text style={styles.historyHintText}>↑</Text>
      </Pressable>

      {/* History sheet overlay */}
      <HistorySheet
        visible={historyVisible}
        onClose={() => setHistoryVisible(false)}
      />
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
  topHalf: {
    // no extra background — pure black
  },
  bottomHalf: {
    // no extra background — pure black
  },
  rotated: {
    flex: 1,
    transform: [{ rotate: '180deg' }],
  },
  dividerArea: {
    paddingVertical: 12,
    justifyContent: 'center',
  },
  errorContainer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 16,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.7)',
  },
  errorMsg: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.3)',
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  retryText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.5)',
  },
  historyHint: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyHintText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.25)',
  },
});
