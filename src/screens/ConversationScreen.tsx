// ConversationScreen — bidirectional translation surface.
//
//   Phone laid flat on the table between two speakers. Each speaker's PTT
//   sits at THEIR edge of the phone — partner's at the top, user's at the
//   bottom — so each thumb lands naturally on the closest button. The
//   translated text leans toward the center of the device, where the
//   conversation actually happens. There is no hairline divider: the
//   silence between the two source lines IS the divider.
//
//   ┌─────────────────────────────┐
//   │   ●  online                 │ ← partner's edge chrome
//   │                             │
//   │           ◯                 │ ← partner's PTT (rotated)
//   │                             │
//   │   español  ▾                │ ← partner identity
//   │                             │
//   │   Lo que el usuario         │ ← what partner reads
//   │   acaba de decir            │
//   │                             │
//   │   — fuente —                │ ← small source line
//   │                             │
//   │           (gap)             │ ← center: pure space, no line
//   │                             │
//   │   — fuente —                │
//   │                             │
//   │   What the partner          │ ← what user reads
//   │   just said                 │
//   │                             │
//   │   english  ▾                │
//   │                             │
//   │           ◯                 │ ← user's PTT
//   │                             │
//   │   ⌘  ajustes                │ ← user's edge chrome
//   └─────────────────────────────┘

import React, { useEffect, useMemo, useState } from 'react';
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
  LanguagePickerSheet,
  PTTButton,
  StateMorph,
  Text,
  color,
  motion,
  space,
} from '../ui';

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
  const networkState = useNetworkStore(s => s.state);
  const [pickerSlot, setPickerSlot] = useState<PickerSlot>(null);

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

  const onPickLanguage = (code: string) => {
    if (pickerSlot === 'partner') setPersonLanguage('B', code);
    else if (pickerSlot === 'self') setPersonLanguage('A', code);
    setPickerSlot(null);
  };

  const excludeForPicker =
    pickerSlot === 'partner' ? personA.language
      : pickerSlot === 'self' ? personB.language
      : undefined;

  // Top half belongs to the partner (Person B). Their accent is ice blue.
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

      {/* TOP HALF — rotated 180° so the partner sees everything upright. */}
      <View style={styles.half}>
        <View style={styles.flipped}>
          <SpeakerHalf
            speakerLanguage={personB.language}
            partnerLanguage={personA.language}
            activeTurn={topActiveTurn}
            incomingTurn={topIncomingTurn}
            accent={color.accentB}
            accentRing={color.accentBRing}
            accentGlow={color.accentBGlow}
            accentWhisper={color.accentBWhisper}
            edgePadding={insets.top + space.md}
            edgeContent={<NetworkPill state={networkState} />}
            disabled={noKey || (!!activeTurn && activeTurn?.speakerId !== 'person_b')}
            onPressIn={() => handleMicPressIn('person_b')}
            onPressOut={handleMicPressOut}
            onChangeLanguage={() => setPickerSlot('partner')}
          />
        </View>
      </View>

      {/* BOTTOM HALF — user's upright view. */}
      <View style={styles.half}>
        <SpeakerHalf
          speakerLanguage={personA.language}
          partnerLanguage={personB.language}
          activeTurn={bottomActiveTurn}
          incomingTurn={bottomIncomingTurn}
          accent={color.accentA}
          accentRing={color.accentARing}
          accentGlow={color.accentAGlow}
          accentWhisper={color.accentAWhisper}
          edgePadding={insets.bottom + space.md}
          edgeContent={
            <Pressable
              onPress={() => navigation.navigate('Settings')}
              hitSlop={14}
              accessibilityRole="button"
              accessibilityLabel="Ajustes">
              <Text variant="mono" tone="fgFaint" style={styles.settingsLink}>
                ajustes
              </Text>
            </Pressable>
          }
          disabled={noKey || (!!activeTurn && activeTurn?.speakerId !== 'person_a')}
          onPressIn={() => handleMicPressIn('person_a')}
          onPressOut={handleMicPressOut}
          onChangeLanguage={() => setPickerSlot('self')}
        />
      </View>

      {noKey && (
        <View style={styles.bannerWrap} pointerEvents="box-none">
          <Pressable
            style={styles.banner}
            onPress={() => navigation.navigate('Settings')}>
            <Text variant="caption" tone="fgFaint" style={styles.bannerEyebrow}>
              CONFIGURACIÓN
            </Text>
            <Text variant="body" tone="fg" style={styles.bannerBody}>
              Falta la API key de Mistral.
            </Text>
            <Text variant="bodySmall" tone="fgMuted" style={styles.bannerHint}>
              Toca para añadirla.
            </Text>
          </Pressable>
        </View>
      )}

      <LanguagePickerSheet
        visible={pickerSlot !== null}
        excludeCode={excludeForPicker}
        onSelect={onPickLanguage}
        onClose={() => setPickerSlot(null)}
      />
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

// ── SpeakerHalf ──────────────────────────────────────────────────────────────
//
// One speaker's entire reading area, written in their reading order top-down.
// On the partner's half, the parent View is rotated 180° so this same
// reading-order layout flips into the correct on-screen position (PTT lands
// at the partner's edge of the phone).
//
//   reading top:    edge chrome  (status / settings)  ←- wait, no.
//
// Actually written top-down:
//   1. source line  (closest to center divider in user's POV)
//   2. big text
//   3. identity chip
//   4. PTT button
//   5. edge chrome  (closest to phone edge in user's POV)

interface SpeakerHalfProps {
  readonly speakerLanguage: string;
  readonly partnerLanguage: string;
  readonly activeTurn: Turn | null;
  readonly incomingTurn: Turn | null;
  readonly accent: string;
  readonly accentRing: string;
  readonly accentGlow: string;
  readonly accentWhisper: string;
  readonly edgePadding: number;
  readonly edgeContent: React.ReactNode;
  readonly disabled: boolean;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
  readonly onChangeLanguage: () => void;
}

function SpeakerHalf({
  speakerLanguage,
  partnerLanguage,
  activeTurn,
  incomingTurn,
  accent,
  accentRing,
  accentGlow,
  accentWhisper,
  edgePadding,
  edgeContent,
  disabled,
  onPressIn,
  onPressOut,
  onChangeLanguage,
}: SpeakerHalfProps): React.JSX.Element {
  const speakerLang = getLanguage(speakerLanguage);
  const partnerLang = getLanguage(partnerLanguage);

  // The big text — what THIS speaker reads — is the OTHER side's translation
  // rendered in MY language.
  const incomingText = incomingTurn?.translatedText ?? '';
  const incomingStage = incomingTurn?.stage ?? null;

  // Source line — the user's own captured speech while talking, OR the
  // partner's source if a turn just completed (so the listener can verify
  // what was said vs how it was rendered).
  const ownSource = activeTurn?.sourceText ?? '';
  const partnerSource = incomingTurn?.sourceText ?? '';

  // Animate big text in.
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
  const showMorph = stageForMorph !== null && stageForMorph !== 'done';

  // Reveal source line either while speaking (own) or after a completed turn
  // (partner's, paired with the translated text above).
  const sourceNode =
    activeTurn !== null && ownSource.length > 0 ? (
      <SourceLine label={speakerLang.endonym} text={ownSource} />
    ) : activeTurn === null && partnerSource.length > 0 && incomingText.length > 0 ? (
      <SourceLine label={partnerLang.endonym} text={partnerSource} />
    ) : null;

  return (
    <View style={halfStyles.root}>
      {/* 1. Source line — closest to the center divider. */}
      <View style={halfStyles.sourceSlot}>{sourceNode}</View>

      {/* 2. Big translated text — the hero. */}
      <View style={halfStyles.big}>
        {incomingText.length > 0 ? (
          <Animated.Text style={[halfStyles.bigText, bigStyle]}>{incomingText}</Animated.Text>
        ) : (
          <Text variant="displayHuge" tone="fgGhost" style={halfStyles.placeholder}>
            {speakerLang.endonym}
          </Text>
        )}
        {incomingTurn?.stage === 'error' && (
          <Text variant="bodySmall" tone="error" style={halfStyles.errorText}>
            ⚠  {incomingTurn.errorMessage ?? 'Error de traducción'}
          </Text>
        )}
      </View>

      {/* 3. Identity strip — language label + state morph. Tap to change. */}
      <View style={halfStyles.identityRow}>
        <Pressable
          onPress={onChangeLanguage}
          hitSlop={14}
          accessibilityRole="button"
          accessibilityLabel={`Cambiar idioma. Actual: ${speakerLang.name}`}
          style={({ pressed }) => [halfStyles.identityChip, pressed && halfStyles.identityChipPressed]}>
          <View style={[halfStyles.identityDot, { backgroundColor: accent }]} />
          <Text variant="caption" tone="fgMuted">
            {speakerLang.endonym.toUpperCase()}
          </Text>
          <Text variant="mono" tone="fgGhost" style={halfStyles.changeChevron}>
            ▾
          </Text>
        </Pressable>
        <View style={halfStyles.flex} />
        {showMorph && (
          <View style={halfStyles.morphSlot}>
            <StateMorph stage={stageForMorph} accent={accent} size={18} />
          </View>
        )}
      </View>

      {/* 4. PTT button — the object. */}
      <View style={halfStyles.buttonSlot}>
        <PTTButton
          label={speakerLanguage || '—'}
          accent={accent}
          accentRing={accentRing}
          accentGlow={accentGlow}
          accentWhisper={accentWhisper}
          active={activeTurn !== null}
          disabled={disabled}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
        />
      </View>

      {/* 5. Edge chrome — at the speaker's near-edge of the phone. */}
      <View style={[halfStyles.edgeRow, { paddingBottom: edgePadding }]}>
        {edgeContent}
      </View>
    </View>
  );
}

function SourceLine({ label, text }: { readonly label: string; readonly text: string }): React.JSX.Element {
  return (
    <View>
      <Text variant="mono" tone="fgGhost" style={halfStyles.sourceLabel}>
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
    state === 'online' ? 'en línea' :
    state === 'offline' ? 'sin conexión' :
    'conectando';
  return (
    <View style={pillStyles.pill}>
      <View style={[pillStyles.dot, { backgroundColor: dotColor }]} />
      <Text variant="mono" tone="fgFaint" style={pillStyles.label}>{label}</Text>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },

  half: { flex: 1 },
  flipped: { flex: 1, transform: [{ rotate: '180deg' }] },

  settingsLink: {
    letterSpacing: 1.4,
    paddingVertical: space.xs,
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

const halfStyles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: space.xl,
  },
  flex: { flex: 1 },

  // 1. Source line — small, near the center divider.
  sourceSlot: {
    minHeight: 36,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  sourceLabel: {
    marginBottom: 4,
    fontSize: 9.5,
    letterSpacing: 1.2,
  },

  // 2. Big text — fills the middle of the half.
  big: {
    flex: 1,
    justifyContent: 'flex-start',
    paddingTop: space.xs,
    paddingBottom: space.sm,
  },
  bigText: {
    color: color.fg,
    fontSize: 34,
    lineHeight: 42,
    fontWeight: '300',
    letterSpacing: -0.6,
  },
  placeholder: {
    opacity: 0.18,
    fontWeight: '200',
  },
  errorText: {
    marginTop: space.sm,
  },

  // 3. Identity row.
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 22,
    marginBottom: space.md,
  },
  identityChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  identityChipPressed: {
    backgroundColor: color.surface2,
    borderColor: color.hairlineStrong,
  },
  identityDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 8,
  },
  changeChevron: {
    marginLeft: 8,
    opacity: 0.7,
  },
  morphSlot: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // 4. PTT button slot.
  buttonSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: -space.lg, // pull the halo into surrounding chrome
  },

  // 5. Edge chrome.
  edgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: space.xs,
  },
});

const pillStyles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 0,
    paddingVertical: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 8,
  },
  label: {
    letterSpacing: 1.4,
  },
});
