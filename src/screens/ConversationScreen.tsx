// ConversationScreen — bidirectional translation surface.
//
//   Phone laid flat on the table between two speakers:
//
//   ┌─────────────────────────────┐
//   │  ⌘ ajustes    ●  online     │ ← top status row (rotated for partner)
//   │                             │
//   │  TOP HALF — partner's view  │   text rotated 180°
//   │  reads upright across the   │   so the counterparty sees normal
//   │  table                      │
//   │                             │
//   │═══ MIC BAR ═════════════════│   two PTT buttons sit on the divider
//   │                             │
//   │  BOTTOM HALF — your view    │   text upright
//   │                             │
//   └─────────────────────────────┘
//
// One speaker presses the PTT closest to them, holds while talking,
// releases. The orchestrator's half-duplex lock guarantees only one turn
// runs at a time. Each turn's translation is rendered on the recipient's
// half — i.e. translated text appears upright in the language the listener
// reads.

import React, { useEffect, useMemo } from 'react';
import { Pressable, StatusBar, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import { useConversationStore, type Turn, type TurnStage } from '../store/conversationStore';
import { useNetworkStore } from '../store/networkStore';
import { conversationOrchestrator } from '../services/pipeline/orchestrator';
import { getLanguage } from '../app/languages';
import type { PersonId } from '../app/types';
import type { RootStackParamList } from '../navigation/types';
import {
  PTTButton,
  StateMorph,
  Text,
  color,
  motion,
  space,
} from '../ui';

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

  const activeTurn = useMemo(
    () => turns.find(t => t.id === activeTurnId) ?? null,
    [turns, activeTurnId],
  );
  const lastTurnA = useMemo(() => findLastTurn(turns, 'person_a'), [turns]);
  const lastTurnB = useMemo(() => findLastTurn(turns, 'person_b'), [turns]);

  const noKey = apiKey.trim() === '';

  const handleMicPressIn = (speakerId: PersonId) => {
    if (noKey) return;
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

  // Top half belongs to the partner (Person B). Their accent is azure.
  // Bottom half belongs to the user (Person A). Their accent is amber.
  const topActiveTurn = activeTurn?.speakerId === 'person_b' ? activeTurn : null;
  const bottomActiveTurn = activeTurn?.speakerId === 'person_a' ? activeTurn : null;

  // Each speaker's PANE shows what the OTHER said in THEIR language.
  // Partner reads what user said → take user's last turn (lastTurnA).
  // User reads what partner said → take partner's last turn (lastTurnB).
  const topIncomingTurn = lastTurnA;
  const bottomIncomingTurn = lastTurnB;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={color.bg} />

      {/* TOP HALF — rotated 180° so partner reads upright across the table */}
      <View style={[styles.half, styles.halfTop, { paddingTop: insets.top + space.sm }]}>
        <View style={styles.flipped}>
          {/* The status row sits at what is visually the "top" of the
              partner's reading orientation, i.e. the chrome closest to the
              centre divider. */}
          <View style={styles.topChromeRow}>
            <NetworkPill state={networkState} />
            <View style={styles.flex} />
          </View>
          <SpeakerPane
            speakerLanguage={personB.language}
            partnerLanguage={personA.language}
            activeTurn={topActiveTurn}
            incomingTurn={topIncomingTurn}
            accent={color.accentB}
            side="top"
          />
        </View>
      </View>

      {/* CENTER MIC BAR */}
      <View style={styles.micBar}>
        <View style={styles.dividerLine} />
        <View style={styles.micRow}>
          <PTTButton
            label={personB.language || '—'}
            accent={color.accentB}
            accentRing={color.accentBRing}
            active={!!topActiveTurn}
            disabled={noKey || (!!activeTurn && activeTurn?.speakerId !== 'person_b')}
            onPressIn={() => handleMicPressIn('person_b')}
            onPressOut={handleMicPressOut}
            inverted
          />
          <PTTButton
            label={personA.language || '—'}
            accent={color.accentA}
            accentRing={color.accentARing}
            active={!!bottomActiveTurn}
            disabled={noKey || (!!activeTurn && activeTurn?.speakerId !== 'person_a')}
            onPressIn={() => handleMicPressIn('person_a')}
            onPressOut={handleMicPressOut}
          />
        </View>
        <View style={styles.dividerLine} />
      </View>

      {/* BOTTOM HALF — user's upright view */}
      <View style={[styles.half, styles.halfBottom, { paddingBottom: insets.bottom + space.sm }]}>
        <SpeakerPane
          speakerLanguage={personA.language}
          partnerLanguage={personB.language}
          activeTurn={bottomActiveTurn}
          incomingTurn={bottomIncomingTurn}
          accent={color.accentA}
          side="bottom"
        />
        <View style={styles.bottomChromeRow}>
          <View style={styles.flex} />
          <Pressable
            onPress={() => navigation.navigate('Settings')}
            hitSlop={14}
            accessibilityRole="button"
            accessibilityLabel="Ajustes">
            <Text variant="mono" tone="fgFaint">AJUSTES</Text>
          </Pressable>
        </View>
      </View>

      {noKey && (
        <View style={styles.bannerWrap} pointerEvents="box-none">
          <Pressable
            style={styles.banner}
            onPress={() => navigation.navigate('Settings')}>
            <Text variant="bodySmall" tone="fg">
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
  readonly speakerLanguage: string;
  readonly partnerLanguage: string;
  readonly activeTurn: Turn | null;
  readonly incomingTurn: Turn | null;
  readonly accent: string;
  readonly side: 'top' | 'bottom';
}

function SpeakerPane({
  speakerLanguage,
  partnerLanguage,
  activeTurn,
  incomingTurn,
  accent,
  side,
}: SpeakerPaneProps): React.JSX.Element {
  const speakerLang = getLanguage(speakerLanguage);
  const partnerLang = getLanguage(partnerLanguage);

  // Big text: what THIS speaker should READ — i.e. the OTHER side's
  // translated text in MY language.
  const incomingText = incomingTurn?.translatedText ?? '';
  const incomingStage = incomingTurn?.stage ?? null;

  // Small text: this speaker's own source captured live, OR the partner's
  // source if we just finished a turn (so the speaker can verify what was
  // said vs how it was rendered).
  const ownSource = activeTurn?.sourceText ?? '';
  const partnerSource = incomingTurn?.sourceText ?? '';

  // Animate the big text in when it changes.
  const opacity = useSharedValue(0);
  useEffect(() => {
    if (incomingText.length > 0) {
      opacity.value = withTiming(1, { duration: motion.normal, easing: Easing.out(Easing.quad) });
    } else {
      opacity.value = withTiming(0, { duration: motion.fast });
    }
  }, [incomingText, opacity]);

  const bigStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  const stageForMorph: TurnStage | null = activeTurn?.stage ?? incomingStage ?? null;

  return (
    <View style={[paneStyles.pane, side === 'top' ? paneStyles.topAlign : paneStyles.bottomAlign]}>
      {/* Identity strip — language code + script morph */}
      <View style={paneStyles.identity}>
        <View style={[paneStyles.identityDot, { backgroundColor: accent }]} />
        <Text variant="mono" tone="fgFaint">
          {speakerLang.endonym.toUpperCase()}  ·  {speakerLang.code.toUpperCase()}
        </Text>
        <View style={paneStyles.flex} />
        {stageForMorph !== null && stageForMorph !== 'done' && (
          <View style={paneStyles.morphSlot}>
            <StateMorph stage={stageForMorph} accent={accent} size={16} />
          </View>
        )}
      </View>

      {/* Big translated text or empty placeholder */}
      <View style={paneStyles.big}>
        {incomingText.length > 0 ? (
          <Animated.Text style={[paneStyles.bigText, bigStyle]}>{incomingText}</Animated.Text>
        ) : (
          <Text variant="displayLarge" tone="fgGhost" style={paneStyles.placeholder}>
            {speakerLang.endonym}
          </Text>
        )}
      </View>

      {/* Source line — what was actually said */}
      <View style={paneStyles.sourceLine}>
        {activeTurn !== null && ownSource.length > 0 ? (
          <SourceLine label={speakerLang.endonym} text={ownSource} />
        ) : activeTurn === null && partnerSource.length > 0 && incomingText.length > 0 ? (
          <SourceLine label={partnerLang.endonym} text={partnerSource} />
        ) : null}
      </View>

      {incomingTurn?.stage === 'error' && (
        <Text variant="bodySmall" tone="error" style={paneStyles.errorText}>
          ⚠  {incomingTurn.errorMessage ?? 'Error de traducción'}
        </Text>
      )}
    </View>
  );
}

function SourceLine({ label, text }: { readonly label: string; readonly text: string }): React.JSX.Element {
  return (
    <View>
      <Text variant="caption" tone="fgGhost" style={paneStyles.sourceLabel}>
        {label.toUpperCase()}
      </Text>
      <Text variant="bodySmall" tone="fgFaint" numberOfLines={3}>
        {text}
      </Text>
    </View>
  );
}

// ── Network pill ─────────────────────────────────────────────────────────────

function NetworkPill({ state }: { readonly state: 'unknown' | 'online' | 'offline' }): React.JSX.Element {
  const dotColor =
    state === 'online' ? color.ok :
    state === 'offline' ? color.error :
    color.fgGhost;
  const label =
    state === 'online' ? 'EN LÍNEA' :
    state === 'offline' ? 'SIN CONEXIÓN' :
    'CONECTANDO';
  return (
    <View style={pillStyles.pill}>
      <View style={[pillStyles.dot, { backgroundColor: dotColor }]} />
      <Text variant="mono" tone="fgFaint">{label}</Text>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  flex: { flex: 1 },

  half: { flex: 1, paddingHorizontal: space.xl },
  halfTop: { justifyContent: 'flex-end' },
  halfBottom: { justifyContent: 'space-between' },
  flipped: { flex: 1, transform: [{ rotate: '180deg' }] },

  topChromeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: space.xs,
    paddingBottom: space.xs,
  },
  bottomChromeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: space.xs,
  },

  micBar: {
    paddingVertical: space.xs,
  },
  dividerLine: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  micRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: space.md,
  },

  bannerWrap: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    top: '45%',
    alignItems: 'center',
  },
  banner: {
    backgroundColor: '#141414',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: color.hairlineStrong,
  },
});

const paneStyles = StyleSheet.create({
  pane: {
    flex: 1,
    paddingVertical: space.md,
  },
  topAlign: { justifyContent: 'flex-end' },
  bottomAlign: { justifyContent: 'flex-start' },
  flex: { flex: 1 },

  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: space.sm,
    minHeight: 18,
  },
  identityDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: space.xs,
  },
  morphSlot: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },

  big: {
    minHeight: 110,
    justifyContent: 'flex-start',
  },
  bigText: {
    color: color.fg,
    fontSize: 30,
    lineHeight: 38,
    fontWeight: '300',
    letterSpacing: -0.4,
  },
  placeholder: {
    opacity: 0.45,
  },

  sourceLine: {
    marginTop: space.md,
    minHeight: 36,
  },
  sourceLabel: {
    marginBottom: 4,
  },
  errorText: {
    marginTop: space.xs,
  },
});

const pillStyles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.surface1,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
});
