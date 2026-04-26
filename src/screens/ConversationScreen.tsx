// ConversationScreen — two-half live translation surface.
//
// Layout (portrait, single user holding the phone, looking at it):
//
//   ┌─────────────────────────────┐
//   │  ⚙ settings   ●  network    │ ← top status row
//   │                             │
//   │   TOP HALF   (Person B)     │
//   │   ─ Person B's translation  │  ← what A said, in B's language
//   │     (what they need to read)│
//   │   ─ Person B's source       │  ← B's own words mid-recording
//   │   [  🎤 PTT for B  ]        │
//   │═══════════════════════════ │
//   │   [  🎤 PTT for A  ]        │
//   │   ─ Person A's source       │  ← A's own words mid-recording
//   │   ─ Person A's translation  │  ← what B said, in A's language
//   │   BOTTOM HALF   (Person A)  │
//   │                             │
//   └─────────────────────────────┘
//
// The mic buttons sit AT THE DIVIDER so both speakers can reach without
// flipping the phone. Each PTT is hold-to-talk; release fires the rest of
// the pipeline. The orchestrator's half-duplex lock guarantees only one
// turn runs at a time even if both are pressed (last press wins).

import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import { useConversationStore, type Turn, type TurnStage } from '../store/conversationStore';
import { useNetworkStore } from '../store/networkStore';
import { conversationOrchestrator } from '../services/pipeline/orchestrator';
import { getLanguage } from '../app/languages';
import type { PersonId } from '../app/types';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

export function ConversationScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const personA = useSettingsStore(s => s.personA);
  const personB = useSettingsStore(s => s.personB);
  const apiKey = useSettingsStore(s => s.mistralApiKey);
  const translationModel = useSettingsStore(s => s.translationModel);
  const turns = useConversationStore(s => s.turns);
  const activeTurnId = useConversationStore(s => s.activeTurnId);
  const networkState = useNetworkStore(s => s.state);

  // Configure + prewarm orchestrator whenever credentials change.
  useEffect(() => {
    conversationOrchestrator.configure({ apiKey, translationModel });
    if (apiKey) {
      void conversationOrchestrator.prewarm().catch(() => {});
    }
  }, [apiKey, translationModel]);

  // The active turn — to read live source text from it.
  const activeTurn = useMemo(
    () => turns.find(t => t.id === activeTurnId) ?? null,
    [turns, activeTurnId],
  );
  // The most recent completed/active turn for each speaker, to drive the
  // "what they last said" panes.
  const lastTurnA = useMemo(() => findLastTurn(turns, 'person_a'), [turns]);
  const lastTurnB = useMemo(() => findLastTurn(turns, 'person_b'), [turns]);

  const noKey = apiKey.trim() === '';

  const handleMicPressIn = (speakerId: PersonId) => {
    if (noKey) return;
    // Guard against double-fire: only block if there's a turn that's still
    // ACTIVE (not done/error). Defensive — the orchestrator also guards on
    // its own state — but covers any drift between store and orchestrator.
    if (activeTurn && activeTurn.stage !== 'done' && activeTurn.stage !== 'error') {
      return;
    }
    const sourceLang = speakerId === 'person_a' ? personA.language : personB.language;
    const targetLang = speakerId === 'person_a' ? personB.language : personA.language;
    if (!sourceLang || !targetLang) return;
    void conversationOrchestrator
      .beginTurn({ speakerId, sourceLang, targetLang })
      .catch(err => console.warn('[Conversation] turn failed:', err));
  };

  const handleMicPressOut = () => {
    void conversationOrchestrator.endTurn().catch(err => {
      console.warn('[Conversation] endTurn failed:', err);
    });
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />

      {/* TOP HALF — Persona B's view */}
      <View style={[styles.half, styles.halfTop, { paddingTop: insets.top + 12 }]}>
        <View style={styles.statusRow}>
          <NetworkPill state={networkState} />
          <View style={styles.flex} />
          <Pressable
            onPress={() => navigation.navigate('Settings')}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Ajustes">
            <Text style={styles.gear}>⚙</Text>
          </Pressable>
        </View>

        <SpeakerPane
          speakerLanguage={personB.language}
          partnerLanguage={personA.language}
          activeTurn={activeTurn?.speakerId === 'person_b' ? activeTurn : null}
          incomingTurn={lastTurnA}
          orientation="top"
        />
      </View>

      {/* CENTER MIC BAR — both PTT buttons sit on the dividing line */}
      <View style={styles.micBar}>
        <View style={styles.divider} />
        <View style={styles.micRow}>
          <MicButton
            label={personB.language || '—'}
            isActive={activeTurn?.speakerId === 'person_b'}
            isDisabled={noKey || (!!activeTurn && activeTurn?.speakerId !== 'person_b')}
            onPressIn={() => handleMicPressIn('person_b')}
            onPressOut={handleMicPressOut}
          />
          <MicButton
            label={personA.language || '—'}
            isActive={activeTurn?.speakerId === 'person_a'}
            isDisabled={noKey || (!!activeTurn && activeTurn?.speakerId !== 'person_a')}
            onPressIn={() => handleMicPressIn('person_a')}
            onPressOut={handleMicPressOut}
          />
        </View>
      </View>

      {/* BOTTOM HALF — Persona A's view */}
      <View style={[styles.half, styles.halfBottom, { paddingBottom: insets.bottom + 12 }]}>
        <SpeakerPane
          speakerLanguage={personA.language}
          partnerLanguage={personB.language}
          activeTurn={activeTurn?.speakerId === 'person_a' ? activeTurn : null}
          incomingTurn={lastTurnB}
          orientation="bottom"
        />
      </View>

      {noKey && (
        <View style={styles.bannerWrap} pointerEvents="box-none">
          <Pressable
            style={styles.banner}
            onPress={() => navigation.navigate('Settings')}>
            <Text style={styles.bannerText}>
              Falta la API key de Mistral. Tócame para configurarla.
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findLastTurn(turns: readonly Turn[], speakerId: PersonId): Turn | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].speakerId === speakerId) return turns[i];
  }
  return null;
}

// ── SpeakerPane ──────────────────────────────────────────────────────────────

interface SpeakerPaneProps {
  /** The language this speaker speaks (their source). */
  readonly speakerLanguage: string;
  /** The other person's language (translation target). */
  readonly partnerLanguage: string;
  /** If non-null, this speaker is currently mid-turn (recording or piping). */
  readonly activeTurn: Turn | null;
  /** The most recent turn from the OTHER speaker — its translation lives in
   *  `speakerLanguage` and is what this speaker needs to read. */
  readonly incomingTurn: Turn | null;
  readonly orientation: 'top' | 'bottom';
}

function SpeakerPane({
  speakerLanguage,
  partnerLanguage,
  activeTurn,
  incomingTurn,
  orientation,
}: SpeakerPaneProps): React.JSX.Element {
  const speakerLang = getLanguage(speakerLanguage);
  const partnerLang = getLanguage(partnerLanguage);

  // Big text: what THIS speaker should read — i.e., the OTHER side's
  // translated text in MY language. Pulled from incomingTurn.
  const incomingText = incomingTurn?.translatedText ?? '';
  const incomingStage = incomingTurn?.stage ?? null;

  // Small text: this speaker's own source captured live during recording, or
  // the source of incoming turn (so they can see what the partner said).
  const ownSource = activeTurn?.sourceText ?? '';
  const partnerSource = incomingTurn?.sourceText ?? '';

  const containerStyle = orientation === 'top' ? styles.paneTop : styles.paneBottom;

  return (
    <View style={[styles.pane, containerStyle]}>
      {/* Big incoming translation — primary surface */}
      <View style={styles.bigBlock}>
        {incomingText.length > 0 ? (
          <Text style={styles.bigText}>{incomingText}</Text>
        ) : (
          <Text style={styles.placeholder}>
            {speakerLang.endonym}
          </Text>
        )}
        {incomingStage === 'translating' && incomingText.length > 0 && (
          <DotPulse />
        )}
      </View>

      {/* Small captured source from THIS speaker — only during their turn */}
      {activeTurn !== null && ownSource.length > 0 && (
        <View style={styles.smallBlock}>
          <Text style={styles.smallLabel}>{speakerLang.endonym}</Text>
          <Text style={styles.smallText}>{ownSource}</Text>
        </View>
      )}

      {/* Small partner source — last thing they said, for reference */}
      {activeTurn === null && partnerSource.length > 0 && incomingText.length > 0 && (
        <View style={styles.smallBlock}>
          <Text style={styles.smallLabel}>{partnerLang.endonym}</Text>
          <Text style={styles.smallText}>{partnerSource}</Text>
        </View>
      )}

      {/* Stage indicator */}
      {activeTurn !== null && (
        <View style={styles.stageRow}>
          <Text style={styles.stageText}>{stageLabel(activeTurn.stage)}</Text>
        </View>
      )}

      {incomingTurn?.stage === 'error' && (
        <Text style={styles.errorText}>
          ⚠ {incomingTurn.errorMessage ?? 'Error de traducción'}
        </Text>
      )}
    </View>
  );
}

function stageLabel(stage: TurnStage): string {
  switch (stage) {
    case 'recording': return '● Grabando';
    case 'transcribing': return '⋯ Transcribiendo';
    case 'translating': return '⋯ Traduciendo';
    case 'speaking': return '♪ Hablando';
    case 'done': return '✓';
    case 'error': return '⚠';
    default: return '';
  }
}

// ── Mic button with breathing pulse during active turn ───────────────────────

interface MicButtonProps {
  readonly label: string;
  readonly isActive: boolean;
  readonly isDisabled: boolean;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
}

function MicButton({
  label, isActive, isDisabled, onPressIn, onPressOut,
}: MicButtonProps): React.JSX.Element {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isActive) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 1,
            duration: 800,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: 0,
            duration: 800,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulse.setValue(0);
    }
  }, [isActive, pulse]);

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] });

  return (
    <Pressable
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      disabled={isDisabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={`Micrófono ${label}`}
      accessibilityState={{ disabled: isDisabled, busy: isActive }}>
      {({ pressed }) => (
        <View style={styles.micWrap}>
          {isActive && (
            <Animated.View
              style={[
                styles.micRing,
                { transform: [{ scale: ringScale }], opacity: ringOpacity },
              ]}
            />
          )}
          <View
            style={[
              styles.mic,
              pressed && styles.micPressed,
              isActive && styles.micActive,
              isDisabled && styles.micDisabled,
            ]}>
            <Text style={styles.micGlyph}>{isActive ? '●' : '🎤'}</Text>
            <Text style={styles.micLabel}>{label.toUpperCase()}</Text>
          </View>
        </View>
      )}
    </Pressable>
  );
}

// ── Subtle "translating" dot pulse ───────────────────────────────────────────

function DotPulse(): React.JSX.Element {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.timing(a, { toValue: 0, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  return (
    <Animated.View
      style={[styles.translatingDot, { opacity: a.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0.7] }) }]}
    />
  );
}

// ── Network pill ─────────────────────────────────────────────────────────────

function NetworkPill({ state }: { state: 'unknown' | 'online' | 'offline' }): React.JSX.Element {
  const color =
    state === 'online' ? '#4ade80' :
    state === 'offline' ? '#f87171' :
    'rgba(255,255,255,0.35)';
  const label =
    state === 'online' ? 'En línea' :
    state === 'offline' ? 'Sin conexión' :
    'Conectando…';
  return (
    <View style={styles.netPill}>
      <View style={[styles.netDot, { backgroundColor: color }]} />
      <Text style={styles.netLabel}>{label}</Text>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  flex: { flex: 1 },

  half: { flex: 1, paddingHorizontal: 24 },
  halfTop: {},
  halfBottom: { justifyContent: 'flex-end' },

  statusRow: { flexDirection: 'row', alignItems: 'center', height: 28, marginBottom: 8 },
  gear: { color: 'rgba(255,255,255,0.5)', fontSize: 18, paddingHorizontal: 6 },

  netPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  netDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  netLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 11 },

  pane: { flex: 1 },
  paneTop: { justifyContent: 'flex-start' },
  paneBottom: { justifyContent: 'flex-end' },

  bigBlock: { paddingVertical: 12, minHeight: 100 },
  bigText: { color: 'rgba(255,255,255,0.95)', fontSize: 26, fontWeight: '300', lineHeight: 34 },
  placeholder: { color: 'rgba(255,255,255,0.10)', fontSize: 22, fontWeight: '300' },

  smallBlock: { paddingVertical: 6, marginTop: 8 },
  smallLabel: { color: 'rgba(255,255,255,0.30)', fontSize: 11, marginBottom: 2, letterSpacing: 0.8 },
  smallText: { color: 'rgba(255,255,255,0.55)', fontSize: 14, lineHeight: 20 },

  stageRow: { paddingTop: 6 },
  stageText: { color: 'rgba(255,255,255,0.40)', fontSize: 11, letterSpacing: 0.8 },
  translatingDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.6)',
    marginTop: 4,
  },
  errorText: { color: 'rgba(248,113,113,0.85)', fontSize: 12, marginTop: 8 },

  micBar: { paddingVertical: 4 },
  divider: { height: 1, backgroundColor: 'rgba(255,255,255,0.06)' },
  micRow: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 14 },
  micWrap: { width: 92, height: 92, alignItems: 'center', justifyContent: 'center' },
  mic: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  micPressed: { backgroundColor: 'rgba(255,255,255,0.16)' },
  micActive: { backgroundColor: 'rgba(244,114,182,0.25)', borderColor: 'rgba(244,114,182,0.5)' },
  micDisabled: { opacity: 0.35 },
  micRing: {
    position: 'absolute',
    width: 76, height: 76, borderRadius: 38,
    borderWidth: 2, borderColor: 'rgba(244,114,182,0.5)',
  },
  micGlyph: { fontSize: 24 },
  micLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 10, marginTop: 2, letterSpacing: 1 },

  bannerWrap: {
    position: 'absolute', left: 16, right: 16, top: '45%',
    alignItems: 'center',
  },
  banner: {
    backgroundColor: 'rgba(20,20,20,0.95)',
    paddingHorizontal: 18, paddingVertical: 14, borderRadius: 14,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  bannerText: { color: 'rgba(255,255,255,0.92)', fontSize: 13, textAlign: 'center' },
});
