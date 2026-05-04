// ConversationScreen — bidirectional translation surface (Dusk).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, StatusBar, StyleSheet, View, type AppStateStatus } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import { useConversationStore } from '../store/conversationStore';
import { useNetworkStore } from '../store/networkStore';
import { getOrchestrator } from '../services/pipeline/orchestrator';
import type { PersonId } from '../app/types';
import type { RootStackParamList } from '../navigation/types';
import { HANDS_FREE_ENABLED } from '../app/featureFlags';
import {
  DuskBackdrop,
  LanguagePickerSheet,
  Text,
  color,
  haptics,
  space,
} from '../ui';
import { SeamShimmer } from '../ui/animations/SeamShimmer';
import { SpeakerHalf } from './conversation/SpeakerHalf';
import { NetworkPill } from './conversation/NetworkPill';
import { findLastTurn, useTurnHaptics } from './conversation/helpers';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

type PickerSlot = 'partner' | 'self' | null;

export function ConversationScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const personA = useSettingsStore(s => s.personA);
  const personB = useSettingsStore(s => s.personB);
  const setPersonLanguage = useSettingsStore(s => s.setPersonLanguage);
  const apiKey = useSettingsStore(s => s.mistralApiKey);
  const translationModel = useSettingsStore(s => s.translationModel);
  const turns = useConversationStore(s => s.turns);
  const activeTurnId = useConversationStore(s => s.activeTurnId);
  const conversationMode = useConversationStore(s => s.mode);
  const hfActiveSpeaker = useConversationStore(s => s.hfActiveSpeaker);
  const networkState = useNetworkStore(s => s.state);
  const [pickerSlot, setPickerSlot] = useState<PickerSlot>(null);
  const [hfFirstRun, setHfFirstRun] = useState(false);
  const [isHfPaused, setIsHfPaused] = useState(false);

  // SeamShimmer directional pulse state.
  const [seamPulseDir, setSeamPulseDir] = useState<0 | 1 | -1>(0);
  const prevHfSpeakerRef = useRef<PersonId | null>(null);

  useEffect(() => {
    getOrchestrator().configure({ apiKey, translationModel });
    if (apiKey) {
      void getOrchestrator().prewarm().catch(() => {});
    }
  }, [apiKey, translationModel]);

  // Tear down hands-free on unmount and when the app backgrounds — leaving
  // the mic/WS open in either state would silently capture audio.
  useEffect(() => {
    const onAppStateChange = (next: AppStateStatus) => {
      if (next !== 'active' && getOrchestrator().isHandsFreeActive()) {
        void getOrchestrator().disableHandsFree().catch(() => {});
      }
    };
    const sub = AppState.addEventListener('change', onAppStateChange);
    return () => {
      sub.remove();
      if (getOrchestrator().isHandsFreeActive()) {
        void getOrchestrator().disableHandsFree().catch(() => {});
      }
    };
  }, []);

  const activeTurn = useMemo(
    () => turns.find(t => t.id === activeTurnId) ?? null,
    [turns, activeTurnId],
  );
  const lastTurnA = useMemo(() => findLastTurn(turns, 'person_a'), [turns]);
  const lastTurnB = useMemo(() => findLastTurn(turns, 'person_b'), [turns]);

  useTurnHaptics(activeTurn, lastTurnA, lastTurnB);

  // Track HF first-run state. Reset prevHfSpeakerRef on enter so the first
  // pulse of a fresh HF session always fires (even if it matches the last
  // speaker of the previous session).
  const prevModeRef = useRef(conversationMode);
  useEffect(() => {
    if (prevModeRef.current !== conversationMode) {
      if (conversationMode === 'hf') {
        setHfFirstRun(true);
        prevHfSpeakerRef.current = null;
      }
      if (conversationMode === 'ptt') setHfFirstRun(false);
      prevModeRef.current = conversationMode;
    }
  }, [conversationMode]);

  // Clear HF first-run when first translation fires.
  useEffect(() => {
    if (hfActiveSpeaker !== null && hfFirstRun) setHfFirstRun(false);
  }, [hfActiveSpeaker, hfFirstRun]);

  // Derive SeamShimmer pulse direction from HF active speaker transitions.
  useEffect(() => {
    const prev = prevHfSpeakerRef.current;
    const curr = hfActiveSpeaker;
    prevHfSpeakerRef.current = curr;

    if (curr !== null && curr !== prev) {
      // person_b (top) speaking → translation goes to person_a (bottom) → pulse downward (1)
      // person_a (bottom) speaking → translation goes to person_b (top) → pulse upward (-1)
      const dir: 1 | -1 = curr === 'person_b' ? 1 : -1;
      setSeamPulseDir(dir);
      const t = setTimeout(() => setSeamPulseDir(0), 500);
      return () => clearTimeout(t);
    }
  }, [hfActiveSpeaker]);

  const noKey = apiKey.trim() === '';
  const hasLanguages = Boolean(personA.language && personB.language);
  const showHfToggle = HANDS_FREE_ENABLED && !noKey && hasLanguages;
  const isHfActive = conversationMode === 'hf';

  // Offline → pause HF; back online → resume. Keep UI mode='hf' throughout
  // so the microcopy can switch to "hands-free paused — offline" without
  // tearing down the Voxtral session.
  useEffect(() => {
    if (!isHfActive) {
      if (isHfPaused) setIsHfPaused(false);
      return;
    }
    if (networkState === 'offline' && !isHfPaused) {
      setIsHfPaused(true);
      void getOrchestrator().pauseHandsFree().catch(err => {
        console.warn('[Conversation] pauseHandsFree failed:', err);
      });
    } else if (networkState === 'online' && isHfPaused) {
      void getOrchestrator()
        .resumeHandsFree()
        .then(() => setIsHfPaused(false))
        .catch(err => {
          console.warn('[Conversation] resumeHandsFree failed:', err);
        });
    }
  }, [networkState, isHfActive, isHfPaused]);

  const handleMicPressIn = (speakerId: PersonId) => {
    if (noKey || isHfActive) return;
    if (activeTurn && activeTurn.stage !== 'done' && activeTurn.stage !== 'error') return;
    const sourceLang = speakerId === 'person_a' ? personA.language : personB.language;
    const targetLang = speakerId === 'person_a' ? personB.language : personA.language;
    if (!sourceLang || !targetLang) return;

    void getOrchestrator()
      .beginTurn({ speakerId, sourceLang, targetLang })
      .catch(err => console.warn('[Conversation] turn failed:', err));
  };

  const handleMicPressOut = () => {
    if (isHfActive) return;
    void getOrchestrator().endTurn().catch(err => {
      console.warn('[Conversation] endTurn failed:', err);
    });
  };

  const handleHfTap = useCallback(() => {
    if (!isHfActive) return;
    void getOrchestrator().disableHandsFree().catch(err => {
      console.warn('[Conversation] disableHandsFree failed:', err);
    });
  }, [isHfActive]);

  const handleToggleHf = useCallback(() => {
    if (isHfActive) {
      void getOrchestrator().disableHandsFree().catch(err => {
        console.warn('[Conversation] disableHandsFree failed:', err);
      });
    } else {
      if (!personA.language || !personB.language) return;
      void getOrchestrator()
        .enableHandsFree(personA.language, personB.language)
        .catch(err => {
          console.warn('[Conversation] enableHandsFree failed:', err);
        });
    }
  }, [isHfActive, personA.language, personB.language]);

  const onPickLanguage = (code: string) => {
    if (pickerSlot === 'partner') setPersonLanguage('B', code);
    else if (pickerSlot === 'self') setPersonLanguage('A', code);
    setPickerSlot(null);
  };

  const topActiveTurn = activeTurn?.speakerId === 'person_b' ? activeTurn : null;
  const bottomActiveTurn = activeTurn?.speakerId === 'person_a' ? activeTurn : null;

  const firstRun = !noKey && turns.length === 0;

  const topIncomingTurn = lastTurnA;
  const bottomIncomingTurn = lastTurnB;

  // HF toggle edge content (alongside "settings").
  const showPausedCopy = isHfActive && isHfPaused;
  const hfToggleNode = showHfToggle ? (
    <Pressable
      onPress={handleToggleHf}
      hitSlop={14}
      accessibilityRole="button"
      accessibilityLabel={isHfActive ? 'Disable hands-free' : 'Enable hands-free'}>
      <View style={styles.hfToggleRow}>
        {isHfActive && !isHfPaused && <View style={styles.hfActiveDot} />}
        {showPausedCopy && <View style={styles.hfPausedDot} />}
        <Text
          variant="serifSmall"
          tone={isHfActive ? 'fgMuted' : 'fgFaint'}
          style={styles.hfToggleText}>
          {showPausedCopy ? 'hands-free paused — offline' : 'hands-free'}
        </Text>
      </View>
    </Pressable>
  ) : null;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={color.bg} />
      <DuskBackdrop />

      {/* SeamShimmer — directional pulse in HF mode. */}
      {isHfActive && <SeamShimmer pulseDirection={seamPulseDir} />}

      {/* TOP HALF — rotated 180deg so the partner sees everything upright. */}
      <View style={styles.half}>
        <View style={styles.flipped}>
          <SpeakerHalf
            speakerId="person_b"
            speakerLanguage={personB.language}
            partnerLanguage={personA.language}
            activeTurn={topActiveTurn}
            incomingTurn={topIncomingTurn}
            accent={color.accentB}
            accentRing={color.accentBRing}
            edgePadding={insets.top + space.md}
            edgeContent={<NetworkPill state={networkState} />}
            disabled={noKey || (!isHfActive && !!activeTurn && activeTurn?.speakerId !== 'person_b')}
            firstRun={firstRun}
            firstHfRun={hfFirstRun}
            onPressIn={() => handleMicPressIn('person_b')}
            onPressOut={handleMicPressOut}
            onTap={handleHfTap}
            onChangeLanguage={() => setPickerSlot('partner')}
          />
        </View>
      </View>

      {/* BOTTOM HALF — user's upright view. */}
      <View style={styles.half}>
        <SpeakerHalf
          speakerId="person_a"
          speakerLanguage={personA.language}
          partnerLanguage={personB.language}
          activeTurn={bottomActiveTurn}
          incomingTurn={bottomIncomingTurn}
          accent={color.accentA}
          accentRing={color.accentARing}
          edgePadding={insets.bottom + space.md}
          edgeContent={
            <View style={styles.bottomEdge}>
              <Pressable
                onPress={() => navigation.navigate('Settings')}
                hitSlop={14}
                accessibilityRole="button"
                accessibilityLabel="Settings">
                <Text variant="serif" tone="fgFaint" style={styles.settingsLink}>
                  settings
                </Text>
              </Pressable>
              {hfToggleNode && (
                <>
                  <Text variant="serifSmall" tone="fgGhost" style={styles.edgeSep}>·</Text>
                  {hfToggleNode}
                </>
              )}
            </View>
          }
          disabled={noKey || (!isHfActive && !!activeTurn && activeTurn?.speakerId !== 'person_a')}
          firstRun={firstRun}
          firstHfRun={hfFirstRun}
          onPressIn={() => handleMicPressIn('person_a')}
          onPressOut={handleMicPressOut}
          onTap={handleHfTap}
          onChangeLanguage={() => setPickerSlot('self')}
        />
      </View>

      {noKey && (
        <View style={styles.bannerWrap} pointerEvents="box-none">
          <Pressable
            style={styles.banner}
            onPress={() => navigation.navigate('Settings')}>
            <Text variant="caption" tone="fgFaint" style={styles.bannerEyebrow}>
              BEFORE WE START
            </Text>
            <Text variant="body" tone="fg" style={styles.bannerBody}>
              Connect Parly to its brain.
            </Text>
            <Text variant="bodySmall" tone="fgMuted" style={styles.bannerHint}>
              Tap here — we'll walk you through it.
            </Text>
          </Pressable>
        </View>
      )}

      <LanguagePickerSheet
        side="top"
        visible={pickerSlot === 'partner'}
        excludeCode={personA.language}
        onSelect={onPickLanguage}
        onClose={() => setPickerSlot(null)}
      />
      <LanguagePickerSheet
        side="bottom"
        visible={pickerSlot === 'self'}
        excludeCode={personB.language}
        onSelect={onPickLanguage}
        onClose={() => setPickerSlot(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  half: { flex: 1 },
  flipped: { flex: 1, transform: [{ rotate: '180deg' }] },

  bottomEdge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  settingsLink: {
    paddingVertical: space.xs,
  },
  edgeSep: {
    marginHorizontal: 6,
    paddingVertical: space.xs,
  },
  hfToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.xs,
  },
  hfActiveDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#FFFFFF',
    marginRight: 5,
    // Glow approximated via border (RN doesn't support box-shadow on View).
    shadowColor: '#FFFFFF',
    shadowOpacity: 0.9,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 0 },
    elevation: 2,
  },
  hfPausedDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#666666',
    marginRight: 5,
  },
  hfToggleText: {
    // fontSize 11 via serifSmall variant
  },

  bannerWrap: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    top: '47%',
    alignItems: 'center',
  },
  banner: {
    backgroundColor: '#0E0E0E',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    alignItems: 'center',
    minWidth: 240,
  },
  bannerEyebrow: {
    marginBottom: 6,
  },
  bannerBody: {
    marginBottom: 4,
  },
  bannerHint: {},
});
