import React, { useEffect } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import LinearGradient from 'react-native-linear-gradient';
import type { Turn, TurnStage } from '../../store/conversationStore';
import { useConversationStore } from '../../store/conversationStore';
import type { PersonId } from '../../app/types';
import { getLanguage } from '../../app/languages';
import { stageMicrocopy } from './helpers';
import {
  PTTButton,
  StateMorph,
  Text,
  color,
  motion,
  space,
} from '../../ui';
import type { DiscMode } from '../../ui/primitives/PTTButton';

// ── SourceLine ──────────────────────────────────────────────────────────────

function SourceLine({ label, text }: { readonly label: string; readonly text: string }): React.JSX.Element {
  return (
    <View>
      <Text variant="serifTiny" tone="fgFaint" style={styles.sourceLabel}>
        {label.toLowerCase()}
      </Text>
      <Text variant="serif" tone="fgMuted" numberOfLines={2} ellipsizeMode="tail">
        {text}
      </Text>
    </View>
  );
}

// ── SpeakerHalf ─────────────────────────────────────────────────────────────

export interface SpeakerHalfProps {
  readonly speakerId: PersonId;
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
  /** Show the HF welcome card ("Just speak. Tap any disc to exit."). */
  readonly firstHfRun?: boolean;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
  /** Fired on a single tap in HF mode — typically exits hands-free. */
  readonly onTap?: () => void;
  readonly onChangeLanguage: () => void;
}

export function SpeakerHalf({
  speakerId,
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
  firstHfRun = false,
  onPressIn,
  onPressOut,
  onTap,
  onChangeLanguage,
}: SpeakerHalfProps): React.JSX.Element {
  const speakerLang = getLanguage(speakerLanguage);
  const partnerLang = getLanguage(partnerLanguage);

  const conversationMode = useConversationStore(s => s.mode);
  const hfUnroutedSpeaker = useConversationStore(s => s.hfUnroutedSpeaker);

  // Derive disc mode from conversation mode. In HF the disc never reacts
  // per-speaker — we don't know who is talking until audio is transcribed and
  // routed — so both discs hold the neutral resting look; the seam voice wave
  // is the only live element. See SeamControl.
  const discMode: DiscMode = (() => {
    if (conversationMode === 'ptt') {
      return activeTurn !== null
        ? { kind: 'ptt-active' }
        : { kind: 'ptt-idle' };
    }
    return { kind: 'hf-idle' };
  })();

  // Bloom dims to 15% for 600ms on unrouted utterance from this side.
  const unroutedFade = useSharedValue(1);
  useEffect(() => {
    if (hfUnroutedSpeaker === speakerId) {
      unroutedFade.value = withTiming(0.15, { duration: 80 });
      const t = setTimeout(() => {
        unroutedFade.value = withTiming(1, { duration: 520 });
      }, 80);
      return () => clearTimeout(t);
    }
  }, [hfUnroutedSpeaker, speakerId, unroutedFade]);

  const incomingText = incomingTurn?.translatedText ?? '';
  const incomingStage = incomingTurn?.stage ?? null;
  const hasIncomingText = incomingText.length > 0;

  const ownSource = activeTurn?.sourceText ?? '';
  const partnerSource = incomingTurn?.sourceText ?? '';

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

  const scrollY = useSharedValue(0);
  const contentH = useSharedValue(0);
  const viewH = useSharedValue(0);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (e) => { scrollY.value = e.contentOffset.y; },
  });
  const onContentSizeChange = (_w: number, h: number) => { contentH.value = h; };
  const onScrollViewLayout = (e: LayoutChangeEvent) => { viewH.value = e.nativeEvent.layout.height; };

  const topFadeStyle = useAnimatedStyle(() => {
    if (contentH.value <= viewH.value + 1) return { opacity: 0 };
    return { opacity: Math.min(1, scrollY.value / 16) };
  });
  const bottomFadeStyle = useAnimatedStyle(() => {
    if (contentH.value <= viewH.value + 1) return { opacity: 0 };
    const slack = contentH.value - (scrollY.value + viewH.value);
    return { opacity: Math.min(1, Math.max(0, slack / 16)) };
  });

  const stageForMorph: TurnStage | null = activeTurn?.stage ?? incomingStage ?? null;
  const showMorph = stageForMorph !== null && stageForMorph !== 'done';

  const sourceNode =
    activeTurn !== null && ownSource.length > 0 ? (
      <SourceLine label={speakerLang.endonym} text={ownSource} />
    ) : activeTurn === null && partnerSource.length > 0 && incomingText.length > 0 ? (
      <SourceLine label={partnerLang.endonym} text={partnerSource} />
    ) : null;

  return (
    <View style={styles.root}>
      <View style={styles.sourceSlot}>{sourceNode}</View>

      <View style={[styles.big, hasIncomingText && styles.bigWithText]}>
        <Animated.ScrollView
          onScroll={scrollHandler}
          onContentSizeChange={onContentSizeChange}
          onLayout={onScrollViewLayout}
          scrollEventThrottle={16}
          style={styles.bigScroll}
          contentContainerStyle={styles.bigScrollContent}
          showsVerticalScrollIndicator={false}
          bounces={false}>
          {hasIncomingText && (
            <Animated.Text style={[styles.bigText, bigStyle]}>
              {incomingText}
            </Animated.Text>
          )}
          {!hasIncomingText && firstRun && !activeTurn && !firstHfRun && (
            <View style={styles.welcome}>
              <Text variant="serifHero" tone="fgFaint" style={styles.welcomeHeadline}>
                Press and hold to speak.
              </Text>
              <View style={styles.welcomeFlow}>
                <Text variant="serifTiny" tone="fgGhost">
                  {speakerLang.endonym.toUpperCase()}
                </Text>
                <Text variant="serifTiny" tone="fgGhost" style={styles.welcomeFlowArrow}>
                  →
                </Text>
                <Text variant="serifTiny" tone="fgGhost">
                  {partnerLang.endonym.toUpperCase()}
                </Text>
              </View>
            </View>
          )}
          {!hasIncomingText && firstHfRun && !activeTurn && (
            <View style={styles.welcome}>
              <Text variant="serifHero" tone="fgFaint" style={styles.welcomeHeadline}>
                Just speak.
              </Text>
              <Text variant="serifTiny" tone="fgGhost" style={styles.welcomeHfHint}>
                Tap any disc to exit.
              </Text>
            </View>
          )}
          {incomingTurn?.stage === 'error' && (
            <Text variant="bodySmall" tone="error" style={styles.errorText}>
              ⚠  {incomingTurn.errorMessage ?? 'Translation error'}
            </Text>
          )}
        </Animated.ScrollView>
        <Animated.View style={[styles.fadeTop, topFadeStyle]} pointerEvents="none">
          <LinearGradient
            colors={['rgba(0,0,0,0.55)', 'transparent']}
            style={styles.fadeGradient}
          />
        </Animated.View>
        <Animated.View style={[styles.fadeBottom, bottomFadeStyle]} pointerEvents="none">
          <LinearGradient
            colors={['transparent', 'rgba(0,0,0,0.55)']}
            style={styles.fadeGradient}
          />
        </Animated.View>
      </View>

      <View style={styles.identityRow}>
        <Pressable
          onPress={onChangeLanguage}
          hitSlop={14}
          accessibilityRole="button"
          accessibilityLabel={`Change language. Current: ${speakerLang.name}`}
          style={({ pressed }) => [styles.identityChip, pressed && styles.identityChipPressed]}>
          <View style={[styles.identityDot, { backgroundColor: accent }]} />
          <Text variant="caption" tone="fgMuted">
            {speakerLang.endonym.toUpperCase()}
          </Text>
          <Text variant="serifSmall" tone="fgFaint" style={styles.identityCode}>
            {speakerLang.code.toLowerCase()}
          </Text>
          <Text variant="serifSmall" tone="fgGhost" style={styles.changeChevron}>
            ▾
          </Text>
        </Pressable>
        <View style={styles.flex} />
        {showMorph && (
          <View style={styles.statusRow}>
            <Text variant="serifTiny" tone="fgFaint" style={styles.microcopy}>
              {stageMicrocopy(stageForMorph)}
            </Text>
            <View style={styles.morphSlot}>
              <StateMorph stage={stageForMorph} accent={accent} size={18} />
            </View>
          </View>
        )}
      </View>

      <View style={styles.spacer} />

      <View style={styles.buttonSlot}>
        <PTTButton
          label={speakerLanguage || '—'}
          accent={accent}
          accentRing={accentRing}
          active={activeTurn !== null}
          disabled={disabled}
          mode={discMode}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          onTap={onTap}
        />
      </View>

      <View style={[styles.edgeRow, { paddingBottom: edgePadding }]}>
        {edgeContent}
      </View>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: space.xl,
  },
  flex: { flex: 1 },

  sourceSlot: {
    minHeight: 36,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  sourceLabel: {
    marginBottom: 4,
  },

  big: {
    justifyContent: 'flex-start',
    flexShrink: 1,
    minHeight: 0,
    paddingTop: space.xs,
    paddingBottom: space.sm,
  },
  bigWithText: {
    minHeight: 142,
  },
  bigScroll: {
    flexGrow: 0,
  },
  bigScrollContent: {
    flexGrow: 1,
    justifyContent: 'flex-start',
  },
  fadeTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 22,
  },
  fadeBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 22,
  },
  fadeGradient: {
    flex: 1,
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
  welcomeHfHint: {
    marginTop: space.sm,
  },

  buttonSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: -space.lg,
  },

  edgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: space.xs,
  },
});
