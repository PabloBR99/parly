// ConversationScreen — bidirectional translation surface (Dusk).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, StatusBar, StyleSheet, View, type AppStateStatus } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import { useConversationStore } from '../store/conversationStore';
import { useNetworkStore } from '../store/networkStore';
import { getOrchestrator } from '../services/pipeline/orchestrator';
import { validateMistralApiKey } from '../services/auth/validateApiKey';
import type { PersonId } from '../app/types';
import type { RootStackParamList } from '../navigation/types';
import { HANDS_FREE_ENABLED } from '../app/featureFlags';
import { stringsFor } from '../i18n/strings';
import {
  DuskBackdrop,
  LanguagePickerSheet,
  SeamControl,
  Text,
  color,
  haptics,
  space,
} from '../ui';
import type { SeamControlMode } from '../ui/primitives/SeamControl';
import { SeamShimmer } from '../ui/animations/SeamShimmer';
import { SpeakerHalf } from './conversation/SpeakerHalf';
import { NetworkPill } from './conversation/NetworkPill';
import { findLastTurn, useTurnHaptics } from './conversation/helpers';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

type PickerSlot = 'partner' | 'self' | null;

/** Delay before prewarm after a key/model change — absorbs typing bursts. */
const PREWARM_DEBOUNCE_MS = 500;
/** Delay before silently validating a key the user never verified. */
const BACKGROUND_VALIDATE_DELAY_MS = 800;

export function ConversationScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const personA = useSettingsStore(s => s.personA);
  const personB = useSettingsStore(s => s.personB);
  const setPersonLanguage = useSettingsStore(s => s.setPersonLanguage);
  const apiKey = useSettingsStore(s => s.mistralApiKey);
  const keyStatus = useSettingsStore(s => s.keyStatus);
  const setKeyStatus = useSettingsStore(s => s.setKeyStatus);
  const translationModel = useSettingsStore(s => s.translationModel);
  const hfDiscovered = useSettingsStore(s => s.hfDiscovered);
  const setHfDiscovered = useSettingsStore(s => s.setHfDiscovered);
  const turns = useConversationStore(s => s.turns);
  const activeTurnId = useConversationStore(s => s.activeTurnId);
  const conversationMode = useConversationStore(s => s.mode);
  const hfActiveSpeaker = useConversationStore(s => s.hfActiveSpeaker);
  const hfActivity = useConversationStore(s => s.hfActivity);
  const notices = useConversationStore(s => s.notices);
  const networkState = useNetworkStore(s => s.state);
  const [pickerSlot, setPickerSlot] = useState<PickerSlot>(null);
  const [hfFirstRun, setHfFirstRun] = useState(false);
  const [isHfPaused, setIsHfPaused] = useState(false);

  // SeamShimmer directional pulse state.
  const [seamPulseDir, setSeamPulseDir] = useState<0 | 1 | -1>(0);
  const prevHfSpeakerRef = useRef<PersonId | null>(null);

  // configure() is cheap and must be current before any turn; prewarm() opens
  // a real network request, so it's debounced and gated on a validated key —
  // typing a 64-char key must not fire dozens of doomed completions.
  useEffect(() => {
    getOrchestrator().configure({ apiKey, translationModel });
    if (!apiKey || keyStatus !== 'valid') return;
    const timer = setTimeout(() => {
      void getOrchestrator().prewarm().catch(() => {});
    }, PREWARM_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [apiKey, translationModel, keyStatus]);

  // A key that was pasted but never verified gets checked silently in the
  // background: garbage flips to 'invalid' (banner + disabled discs) instead
  // of sailing into a failing first turn under a green badge.
  useEffect(() => {
    if (!apiKey || keyStatus !== 'unvalidated' || networkState === 'offline') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void validateMistralApiKey(apiKey).then(result => {
        if (cancelled) return;
        if (result.status === 'ok') setKeyStatus('valid');
        else if (result.status === 'invalid') setKeyStatus('invalid');
        // network/unknown: leave 'unvalidated' — never punish a flaky link.
      });
    }, BACKGROUND_VALIDATE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiKey, keyStatus, networkState, setKeyStatus]);

  // Tear down live audio when the app backgrounds or the screen unmounts —
  // leaving the mic/WS open in either state would silently capture audio.
  // HF tears down its session; a mid-flight PTT turn is cancelled quietly.
  useEffect(() => {
    const teardown = () => {
      if (getOrchestrator().isHandsFreeActive()) {
        void getOrchestrator().disableHandsFree().catch(() => {});
      } else {
        void getOrchestrator().cancelTurn().catch(() => {});
      }
    };
    const onAppStateChange = (next: AppStateStatus) => {
      if (next !== 'active') teardown();
    };
    const sub = AppState.addEventListener('change', onAppStateChange);
    return () => {
      sub.remove();
      teardown();
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
  // Discs disable for a MISSING or definitively INVALID key. A merely
  // unverified key stays usable — background validation is racing, and an
  // offline start with a good stored key must not lock the table.
  const keyBlocked = noKey || keyStatus === 'invalid';
  const hasLanguages = Boolean(personA.language && personB.language);
  const showHfToggle = HANDS_FREE_ENABLED && !keyBlocked && hasLanguages;
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
    if (keyBlocked || isHfActive) return;
    if (activeTurn && activeTurn.stage !== 'done' && activeTurn.stage !== 'error') return;
    const sourceLang = speakerId === 'person_a' ? personA.language : personB.language;
    const targetLang = speakerId === 'person_a' ? personB.language : personA.language;
    if (!sourceLang || !targetLang) return;

    // Known-offline press: answer immediately in the speaker's language
    // instead of opening a socket that dies against the handshake timeout.
    if (networkState === 'offline') {
      useConversationStore.getState().setNotice(speakerId, { key: 'offline', kind: 'info' });
      return;
    }

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

  // Tap on the live translation → in PTT, stop this turn (both discs
  // unlock); in HF, skip the rest of the readback — a long translation
  // nobody needs spoken to the end shouldn't hold the conversation hostage.
  const handleInterrupt = useCallback(() => {
    haptics.tick();
    if (isHfActive) {
      getOrchestrator().skipHfTurn();
      return;
    }
    void getOrchestrator().cancelTurn().catch(err => {
      console.warn('[Conversation] cancelTurn failed:', err);
    });
  }, [isHfActive]);

  const handleHfTap = useCallback(() => {
    if (!isHfActive) return;
    void getOrchestrator().disableHandsFree().catch(err => {
      console.warn('[Conversation] disableHandsFree failed:', err);
    });
  }, [isHfActive]);

  const handleToggleHf = useCallback(() => {
    // Any deliberate press on the seam control proves the reader found it —
    // retire the discoverability hint for good.
    if (!hfDiscovered) setHfDiscovered(true);
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
  }, [isHfActive, personA.language, personB.language, hfDiscovered, setHfDiscovered]);

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

  // The half-duplex lock, made honest in the affordance (not just a silent
  // guard): while a turn is in flight, only the recording speaker's own disc
  // stays live (they're holding it); everything else is visibly disabled.
  const turnBusy =
    !isHfActive &&
    activeTurn !== null &&
    activeTurn.stage !== 'done' &&
    activeTurn.stage !== 'error';
  const discDisabled = (side: PersonId): boolean =>
    keyBlocked ||
    (turnBusy && !(activeTurn?.speakerId === side && activeTurn?.stage === 'recording'));

  // Hands-free lives on the seam now (SeamControl), not in the footer.
  const hfMode: SeamControlMode = !isHfActive ? 'off' : isHfPaused ? 'paused' : 'on';

  const bannerCopy = noKey
    ? {
        eyebrow: 'BEFORE WE START',
        body: 'Connect Parly to its brain.',
        hint: "Tap here — we'll walk you through it.",
      }
    : keyStatus === 'invalid'
    ? {
        eyebrow: 'CONNECTION PROBLEM',
        body: "That key isn't working.",
        hint: 'Tap here to fix it.',
      }
    : null;

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
            turns={turns}
            activeTurn={topActiveTurn}
            incomingTurn={topIncomingTurn}
            notice={notices.person_b}
            accent={color.accentB}
            accentRing={color.accentBRing}
            edgePadding={insets.top + space.md}
            edgeContent={<NetworkPill state={networkState} lang={personB.language} />}
            disabled={discDisabled('person_b')}
            firstRun={firstRun}
            firstHfRun={hfFirstRun}
            onPressIn={() => handleMicPressIn('person_b')}
            onPressOut={handleMicPressOut}
            onTap={handleHfTap}
            onInterrupt={handleInterrupt}
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
          turns={turns}
          activeTurn={bottomActiveTurn}
          incomingTurn={bottomIncomingTurn}
          notice={notices.person_a}
          accent={color.accentA}
          accentRing={color.accentARing}
          edgePadding={insets.bottom + space.md}
          edgeContent={
            <View style={styles.bottomEdge}>
              {/* The pill lives on BOTH edges — connection state must be
                  readable without turning the phone around. */}
              <NetworkPill state={networkState} lang={personA.language} />
              <View style={styles.edgeGap} />
              <Pressable
                onPress={() => navigation.navigate('Settings')}
                hitSlop={14}
                accessibilityRole="button"
                accessibilityLabel="Settings">
                <Text variant="serif" tone="fgFaint" style={styles.settingsLink}>
                  settings
                </Text>
              </Pressable>
            </View>
          }
          disabled={discDisabled('person_a')}
          firstRun={firstRun}
          firstHfRun={hfFirstRun}
          onPressIn={() => handleMicPressIn('person_a')}
          onPressOut={handleMicPressOut}
          onTap={handleHfTap}
          onInterrupt={handleInterrupt}
          onChangeLanguage={() => setPickerSlot('self')}
        />
      </View>

      {/* Hands-free control — a neutral voice wave seated dead-centre on the
          seam. The wave is the only live element in HF; the discs stay quiet. */}
      {showHfToggle && (
        <SeamControl
          mode={hfMode}
          activity={hfActivity}
          // Until first use, the wave carries its name — one label per
          // reader, each in their own language, the top one flipped.
          hintTop={hfDiscovered ? null : stringsFor(personB.language).handsFree}
          hintBottom={hfDiscovered ? null : stringsFor(personA.language).handsFree}
          onToggle={handleToggleHf}
        />
      )}

      {bannerCopy && (
        <View style={styles.bannerWrap} pointerEvents="box-none">
          <Pressable
            style={styles.banner}
            onPress={() => navigation.navigate('Settings')}>
            <Text variant="caption" tone="fgFaint" style={styles.bannerEyebrow}>
              {bannerCopy.eyebrow}
            </Text>
            <Text variant="body" tone="fg" style={styles.bannerBody}>
              {bannerCopy.body}
            </Text>
            <Text variant="bodySmall" tone="fgMuted" style={styles.bannerHint}>
              {bannerCopy.hint}
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

  settingsLink: {
    paddingVertical: space.xs,
  },
  bottomEdge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  edgeGap: {
    width: space.lg,
  },

  bannerWrap: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    top: '47%',
    alignItems: 'center',
  },
  banner: {
    backgroundColor: color.bgElevated,
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
