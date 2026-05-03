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

export function SpeakerHalf({
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
    onScroll: (e) => {
      scrollY.value = e.contentOffset.y;
    },
  });
  const onContentSizeChange = (_w: number, h: number) => {
    contentH.value = h;
  };
  const onScrollViewLayout = (e: LayoutChangeEvent) => {
    viewH.value = e.nativeEvent.layout.height;
  };

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
          {!hasIncomingText && firstRun && !activeTurn && (
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
          {incomingTurn?.stage === 'error' && (
            <Text variant="bodySmall" tone="error" style={styles.errorText}>
              ⚠  {incomingTurn.errorMessage ?? 'Translation error'}
            </Text>
          )}
        </Animated.ScrollView>
        <Animated.View
          style={[styles.fadeTop, topFadeStyle]}
          pointerEvents="none">
          <LinearGradient
            colors={['rgba(0,0,0,0.55)', 'transparent']}
            style={styles.fadeGradient}
          />
        </Animated.View>
        <Animated.View
          style={[styles.fadeBottom, bottomFadeStyle]}
          pointerEvents="none">
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
          onPressIn={onPressIn}
          onPressOut={onPressOut}
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
