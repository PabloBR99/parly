// ConversationScreen — bidirectional translation surface (Dusk).
//
//   Phone laid flat on the table between two speakers. Each speaker is a
//   sun at one edge — cool bloom at the partner's edge (top, rotated 180°
//   so they read upright), warm bloom at the user's edge (bottom). Their
//   lights bleed toward the centre and meet at the dusk seam. Translation
//   text stays pure white; colour lives in the atmosphere, never in the
//   words.
//
//   ┌─────────────────────────────┐
//   │   ● online                  │ ← partner's edge chrome
//   │                             │
//   │           ◯  cool bloom     │ ← partner's PTT (rotated)
//   │                             │
//   │   ESPAÑOL  es  ▾            │ ← partner identity (serif italic)
//   │                             │
//   │   Lo que el usuario         │ ← what partner reads
//   │   acaba de decir            │
//   │                             │
//   │   ─── source ───            │ ← small serif italic source
//   │                             │
//   │   ── dusk seam ──           │ ← warm × cool encounter
//   │                             │
//   │   ─── source ───            │
//   │                             │
//   │   What the partner          │ ← what user reads
//   │   just said                 │
//   │                             │
//   │   ENGLISH  en  ▾            │
//   │                             │
//   │           ◯  warm bloom     │ ← user's PTT
//   │                             │
//   │           settings          │ ← user's edge chrome
//   └─────────────────────────────┘

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StatusBar, StyleSheet, View } from 'react-native';
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
  DuskBackdrop,
  LanguagePickerSheet,
  PTTButton,
  StateMorph,
  Text,
  color,
  haptics,
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

  // Haptic choreography — felt across the whole turn lifecycle so the user
  // doesn't need to read the screen to know where the machine is.
  useTurnHaptics(activeTurn, lastTurnA, lastTurnB);

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

  // Top half belongs to the partner (Person B) — cool bloom, periwinkle.
  // Bottom half belongs to the user (Person A) — warm bloom, peach.
  const topActiveTurn = activeTurn?.speakerId === 'person_b' ? activeTurn : null;
  const bottomActiveTurn = activeTurn?.speakerId === 'person_a' ? activeTurn : null;

  // First-run discoverability — the press-and-hold gesture isn't universal,
  // especially for older users who expect a single tap. We surface a quiet
  // hint near each disc until either side completes its first turn, then
  // it disappears for good.
  const firstRun = !noKey && turns.length === 0;

  // Each speaker's PANE shows what the OTHER said in THEIR language.
  // Partner reads what user said → take user's last turn (lastTurnA).
  // User reads what partner said → take partner's last turn (lastTurnB).
  const topIncomingTurn = lastTurnA;
  const bottomIncomingTurn = lastTurnB;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={color.bg} />

      {/* Dusk atmosphere — vertical gradient cool→near-black→warm. The
          horizon is the natural near-black band at 50%, no separate
          horizontal element. */}
      <DuskBackdrop />

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
            edgePadding={insets.top + space.md}
            edgeContent={<NetworkPill state={networkState} />}
            disabled={noKey || (!!activeTurn && activeTurn?.speakerId !== 'person_b')}
            firstRun={firstRun}
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
          edgePadding={insets.bottom + space.md}
          edgeContent={
            <Pressable
              onPress={() => navigation.navigate('Settings')}
              hitSlop={14}
              accessibilityRole="button"
              accessibilityLabel="Settings">
              <Text variant="serif" tone="fgFaint" style={styles.settingsLink}>
                settings
              </Text>
            </Pressable>
          }
          disabled={noKey || (!!activeTurn && activeTurn?.speakerId !== 'person_a')}
          firstRun={firstRun}
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

      {/* Two pickers — one for each speaker. The partner's picker docks
          to the screen's top edge (their "bottom" in the rotated half) and
          renders content rotated 180° so they read it upright. The user's
          picker is a conventional bottom sheet. Each is always mounted;
          only the one whose slot is active is visible. */}
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function findLastTurn(turns: readonly Turn[], speakerId: PersonId): Turn | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].speakerId === speakerId) return turns[i];
  }
  return null;
}

function stageMicrocopy(stage: TurnStage | null): string {
  switch (stage) {
    case 'recording': return 'listening';
    case 'transcribing':
    case 'translating': return 'thinking';
    case 'speaking': return 'speaking';
    case 'error': return 'error';
    default: return '';
  }
}

// useTurnHaptics — wires the `haptics` module's pulse / tick / done / error
// to the orchestrator's per-turn state machine. The PTT-press tap is fired
// inside PTTButton itself; everything else flows through here so the felt
// rhythm of a turn matches its visual rhythm without each callsite having
// to know what to fire when.
function useTurnHaptics(
  active: Turn | null,
  lastA: Turn | null,
  lastB: Turn | null,
): void {
  // Active stage transitions — pulse on pipeline moves, tick on first speech.
  const prevActive = useRef<TurnStage | null>(null);
  useEffect(() => {
    const curr = active?.stage ?? null;
    const prev = prevActive.current;
    if (prev !== curr) {
      if (
        (prev === 'recording' && curr === 'transcribing') ||
        (prev === 'transcribing' && curr === 'translating')
      ) {
        haptics.pulse();
      }
      if (prev === 'translating' && curr === 'speaking') {
        haptics.tick();
      }
      prevActive.current = curr;
    }
  }, [active?.stage]);

  // Per-side terminal transitions — done / error when the last turn for
  // a speaker finishes. We split A and B because each speaker's lastTurn
  // is independent; one ends without disturbing the other's prevStage ref.
  useTerminalHaptic(lastA);
  useTerminalHaptic(lastB);
}

function useTerminalHaptic(turn: Turn | null): void {
  const prev = useRef<TurnStage | null>(null);
  useEffect(() => {
    const curr = turn?.stage ?? null;
    if (prev.current !== curr) {
      // Only fire on TRANSITIONS into terminal stages — and never on the
      // first observation (prev=null), which can fire spuriously when a
      // store rehydrates a 'done' turn after navigation.
      if (prev.current !== null) {
        if (curr === 'done') haptics.done();
        else if (curr === 'error') haptics.error();
      }
      prev.current = curr;
    }
  }, [turn?.stage]);
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
  readonly edgePadding: number;
  readonly edgeContent: React.ReactNode;
  readonly disabled: boolean;
  readonly firstRun: boolean;
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
  edgePadding,
  edgeContent,
  disabled,
  firstRun,
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
  const hasIncomingText = incomingText.length > 0;

  // Source line — the user's own captured speech while talking, OR the
  // partner's source if a turn just completed (so the listener can verify
  // what was said vs how it was rendered).
  const ownSource = activeTurn?.sourceText ?? '';
  const partnerSource = incomingTurn?.sourceText ?? '';

  // Reveal — single shared value driving opacity AND a tiny translateY,
  // so the line "settles in" rather than just popping. Depends on the
  // boolean, NOT on incomingText, so each streamed sentence doesn't
  // re-trigger the entrance and jiggle the line back into place.
  const reveal = useSharedValue(0);
  useEffect(() => {
    reveal.value = hasIncomingText
      ? withTiming(1, { duration: motion.normal, easing: Easing.out(Easing.quad) })
      : withTiming(0, { duration: motion.fast });
  }, [hasIncomingText, reveal]);

  const bigStyle = useAnimatedStyle(() => ({
    opacity: reveal.value,
    transform: [{ translateY: (1 - reveal.value) * 6 }],
  }));

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

      {/* 2. Big translated text — the hero when there's content. On the very
              first run (no turns from either side yet) we paint a quiet
              welcome here: serif italic gesture line plus the concrete
              language flow in endonyms, so the speaker can read at a glance
              what the disc does and which way the words travel. The block
              disappears the moment the first turn lands.

              flexShrink:1 + minHeight:0 lets `big` give up height to the
              fixed-height chrome below (chip + disc + edge) when an
              incoming message is long; the ScrollView absorbs the
              overflow so the disc stays anchored at the speaker's edge
              instead of being pushed off-screen. */}
      <View style={halfStyles.big}>
        <ScrollView
          style={halfStyles.bigScroll}
          contentContainerStyle={halfStyles.bigScrollContent}
          showsVerticalScrollIndicator={false}
          bounces={false}>
          {hasIncomingText && (
            <Animated.Text style={[halfStyles.bigText, bigStyle]}>
              {incomingText}
            </Animated.Text>
          )}
          {!hasIncomingText && firstRun && !activeTurn && (
            <View style={halfStyles.welcome}>
              <Text variant="serifHero" tone="fgFaint" style={halfStyles.welcomeHeadline}>
                Press and hold to speak.
              </Text>
              <View style={halfStyles.welcomeFlow}>
                <Text variant="serifTiny" tone="fgGhost">
                  {speakerLang.endonym.toUpperCase()}
                </Text>
                <Text variant="serifTiny" tone="fgGhost" style={halfStyles.welcomeFlowArrow}>
                  →
                </Text>
                <Text variant="serifTiny" tone="fgGhost">
                  {partnerLang.endonym.toUpperCase()}
                </Text>
              </View>
            </View>
          )}
          {incomingTurn?.stage === 'error' && (
            <Text variant="bodySmall" tone="error" style={halfStyles.errorText}>
              ⚠  {incomingTurn.errorMessage ?? 'Translation error'}
            </Text>
          )}
        </ScrollView>
      </View>

      {/* 3. Identity strip — language chip on the left, live status on the right.
              Sits directly under the big text (intrinsic height) so on tall
              phones the chip stays close to the words instead of floating
              down near the disc — matches the mockup proportions where
              big is just a hair taller than the welcome content. */}
      <View style={halfStyles.identityRow}>
        <Pressable
          onPress={onChangeLanguage}
          hitSlop={14}
          accessibilityRole="button"
          accessibilityLabel={`Change language. Current: ${speakerLang.name}`}
          style={({ pressed }) => [halfStyles.identityChip, pressed && halfStyles.identityChipPressed]}>
          <View style={[halfStyles.identityDot, { backgroundColor: accent }]} />
          <Text variant="caption" tone="fgMuted">
            {speakerLang.endonym.toUpperCase()}
          </Text>
          <Text variant="serifSmall" tone="fgFaint" style={halfStyles.identityCode}>
            {speakerLang.code.toLowerCase()}
          </Text>
          <Text variant="serifSmall" tone="fgGhost" style={halfStyles.changeChevron}>
            ▾
          </Text>
        </Pressable>
        <View style={halfStyles.flex} />
        {showMorph && (
          <View style={halfStyles.statusRow}>
            <Text variant="serifTiny" tone="fgFaint" style={halfStyles.microcopy}>
              {stageMicrocopy(stageForMorph)}
            </Text>
            <View style={halfStyles.morphSlot}>
              <StateMorph stage={stageForMorph} accent={accent} size={18} />
            </View>
          </View>
        )}
      </View>

      {/* Spacer — absorbs extra vertical room on tall phones so the disc
          stays anchored near the edge while the chip stays close to the
          big text. Without this, big's flex would expand and float the
          chip down near the bloom. */}
      <View style={halfStyles.spacer} />

      {/* 4. PTT button — the object. */}
      <View style={halfStyles.buttonSlot}>
        <PTTButton
          label={speakerLanguage || '—'}
          accent={accent}
          accentRing={accentRing}
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
  // Source lines sit closest to the dusk seam — the darkest band of the
  // backdrop — so they need a bit more contrast than other secondary
  // chrome. Bumping label fgGhost (16 %) → fgFaint (36 %) and the text
  // itself fgFaint (36 %) → fgMuted (62 %) keeps the design hierarchy
  // (label dimmer than text, text dimmer than the white translation)
  // while making both legible against the near-black centre of the
  // gradient. On AMOLED phones the previous values were almost
  // invisible at the seam.
  return (
    <View>
      <Text variant="serifTiny" tone="fgFaint" style={halfStyles.sourceLabel}>
        {label.toLowerCase()}
      </Text>
      <Text variant="serif" tone="fgMuted" numberOfLines={3}>
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
    state === 'online' ? 'online' :
    state === 'offline' ? 'offline' :
    'connecting';
  return (
    <View style={pillStyles.pill}>
      <View style={[pillStyles.dot, { backgroundColor: dotColor }]} />
      <Text variant="serif" tone="fgFaint" style={pillStyles.label}>{label}</Text>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },

  half: { flex: 1 },
  flipped: { flex: 1, transform: [{ rotate: '180deg' }] },

  settingsLink: {
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
  },

  // 2. Big text — intrinsic height for short content (welcome / a couple
  // of translated lines), but flexShrink:1 + minHeight:0 lets it give up
  // height when the message is long, so the chrome below (chip, disc,
  // edge) keeps its fixed footprint instead of being pushed off-screen.
  // Spacer below identityRow still absorbs slack on tall phones with
  // short content so the chip stays close to the words.
  big: {
    justifyContent: 'flex-start',
    flexShrink: 1,
    minHeight: 0,
    paddingTop: space.xs,
    paddingBottom: space.sm,
  },
  bigScroll: {
    flexGrow: 0,
  },
  bigScrollContent: {
    flexGrow: 1,
    justifyContent: 'flex-start',
  },
  spacer: {
    flex: 1,
  },
  bigText: {
    color: color.fg,
    fontSize: 34,
    lineHeight: 42,
    fontWeight: '300',
    letterSpacing: -0.6,
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
  identityCode: {
    marginLeft: 8,
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
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  microcopy: {
    marginRight: 10,
  },

  // First-run welcome — fills the empty translation slot with a quiet
  // painted-light placeholder. Serif italic on top reads as the app's voice
  // (not a translation), then a tracked-uppercase endonym flow underneath
  // teaches the language direction without a banner or modal.
  welcome: {
    paddingTop: space.xs,
  },
  welcomeHeadline: {
    marginBottom: space.md,
  },
  welcomeFlow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  welcomeFlowArrow: {
    marginHorizontal: space.sm,
    letterSpacing: 1,
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
  label: {},
});
