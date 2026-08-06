import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutChangeEvent, TextStyle } from 'react-native';
import { Pressable, StyleSheet, Text as RNText, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import LinearGradient from 'react-native-linear-gradient';
import type { SpeakerNotice, Turn, TurnStage } from '../../store/conversationStore';
import { useConversationStore } from '../../store/conversationStore';
import type { PersonId } from '../../app/types';
import { getLanguage } from '../../app/languages';
import { noticeText, stringsFor } from '../../i18n/strings';
import { stageMicrocopy } from './helpers';
import {
  PTTButton,
  StateMorph,
  Text,
  color,
  font,
  motion,
  space,
} from '../../ui';
import type { DiscMode } from '../../ui/primitives/PTTButton';

// ── SourceLine ──────────────────────────────────────────────────────────────

function SourceLine({ label, text }: { readonly label: string; readonly text: string }): React.JSX.Element {
  return (
    <View>
      <Text variant="serifTiny" tone="fgMuted" style={styles.sourceLabel}>
        {label.toLowerCase()}
      </Text>
      <Text variant="serif" tone="fgMuted" numberOfLines={2} ellipsizeMode="tail">
        {text}
      </Text>
    </View>
  );
}

/** Keep the END of a growing live transcript visible — the head is old news. */
function tailOf(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

// ── History feed ────────────────────────────────────────────────────────────
//
// Each half carries the whole conversation, readable by ITS reader without
// turning the phone: partner turns render their translation (already in the
// reader's language), the reader's own turns render what they said (their
// words, their language). The newest partner message keeps the hero
// treatment; everything older recedes into a quieter, smaller register the
// reader can scroll back through.

interface FeedItem {
  readonly id: string;
  readonly kind: 'partner' | 'own';
  readonly text: string;
}

/** Hero type steps down as the translation grows — a minute of speech at
 *  34 pt is a wall, not a reading. */
function heroFontFor(len: number): TextStyle {
  if (len <= 150) return font.displayHero;
  if (len <= 380) return font.display;
  return font.displayCompact;
}

const HistoryLine = React.memo(function HistoryLine({
  kind,
  text,
}: {
  readonly kind: 'partner' | 'own';
  readonly text: string;
}): React.JSX.Element {
  // Partner history keeps the sans "reading" voice, smaller and dimmer;
  // the reader's own words take the serif chrome voice — a quote of
  // themselves, not a reading.
  return kind === 'partner' ? (
    <RNText style={styles.historyPartner}>{text}</RNText>
  ) : (
    <Text variant="serif" tone="fgFaint" style={styles.historyOwn}>
      {text}
    </Text>
  );
});

/** Scroll slack (px) beyond which the reader counts as "away from live". */
const DETACH_SLACK_PX = 56;

// ── SpeakerHalf ─────────────────────────────────────────────────────────────

export interface SpeakerHalfProps {
  readonly speakerId: PersonId;
  readonly speakerLanguage: string;
  readonly partnerLanguage: string;
  /** Full conversation — each half derives its own reader's view. */
  readonly turns: readonly Turn[];
  readonly activeTurn: Turn | null;
  readonly incomingTurn: Turn | null;
  /** Notice addressed to THIS half's reader, rendered in their language.
   *  Errors land on the speaker's own half — they are the one who can act. */
  readonly notice: SpeakerNotice | null;
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
  /** Tap on the streaming/spoken translation — interrupts (PTT) or skips
   *  the rest of the readback (HF). */
  readonly onInterrupt?: () => void;
  readonly onChangeLanguage: () => void;
}

export function SpeakerHalf({
  speakerId,
  speakerLanguage,
  partnerLanguage,
  turns,
  activeTurn,
  incomingTurn,
  notice,
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
  onInterrupt,
  onChangeLanguage,
}: SpeakerHalfProps): React.JSX.Element {
  const speakerLang = getLanguage(speakerLanguage);
  const partnerLang = getLanguage(partnerLanguage);
  const t = stringsFor(speakerLanguage);

  const conversationMode = useConversationStore(s => s.mode);
  const hfUnroutedSpeaker = useConversationStore(s => s.hfUnroutedSpeaker);
  const hfLive = useConversationStore(s => s.hfLive);

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

  // Disc + bloom dim to 15% for 600ms on unrouted utterance from this side.
  const unroutedFade = useSharedValue(1);
  const hfUnroutedHere = hfUnroutedSpeaker === speakerId;
  useEffect(() => {
    if (hfUnroutedHere) {
      unroutedFade.value = withTiming(0.15, { duration: 80 });
      const timer = setTimeout(() => {
        unroutedFade.value = withTiming(1, { duration: 520 });
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [hfUnroutedHere, unroutedFade]);
  const unroutedFadeStyle = useAnimatedStyle(() => ({
    opacity: unroutedFade.value,
  }));

  // The reader's feed: chronological, all in their language. Own turns join
  // only once done (while active they live in the source slot); partner
  // turns join the moment translated text starts streaming.
  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [];
    for (const turn of turns) {
      if (turn.speakerId === speakerId) {
        if (turn.stage === 'done' && turn.sourceText.trim().length > 0) {
          items.push({ id: turn.id, kind: 'own', text: turn.sourceText.trim() });
        }
      } else if (turn.translatedText.trim().length > 0) {
        items.push({ id: turn.id, kind: 'partner', text: turn.translatedText.trim() });
      }
    }
    return items;
  }, [turns, speakerId]);

  let lastPartnerIdx = -1;
  for (let i = feed.length - 1; i >= 0; i--) {
    if (feed[i].kind === 'partner') { lastPartnerIdx = i; break; }
  }
  const hasHero = lastPartnerIdx !== -1;
  const heroLen = hasHero ? feed[lastPartnerIdx].text.length : 0;

  const incomingStage = incomingTurn?.stage ?? null;

  const ownSource = activeTurn?.sourceText ?? '';
  const partnerSource = incomingTurn?.sourceText ?? '';

  const reveal = useSharedValue(0);
  useEffect(() => {
    reveal.value = hasHero
      ? withTiming(1, { duration: motion.normal, easing: Easing.out(Easing.quad) })
      : withTiming(0, { duration: motion.fast });
  }, [hasHero, reveal]);

  const bigStyle = useAnimatedStyle(() => ({
    opacity: reveal.value,
    transform: [{ translateY: (1 - reveal.value) * 6 }],
  }));

  // ── Scroll position: stick to the live end unless the reader wanders ─────
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useSharedValue(0);
  const contentH = useSharedValue(0);
  const viewH = useSharedValue(0);
  const detachedSV = useSharedValue(0);
  const stickRef = useRef(true);
  const [detached, setDetachedState] = useState(false);
  const setDetached = useCallback((d: boolean) => {
    stickRef.current = !d;
    setDetachedState(d);
  }, []);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (e) => {
      scrollY.value = e.contentOffset.y;
      const slack = e.contentSize.height - (e.contentOffset.y + e.layoutMeasurement.height);
      const isDetached = slack > DETACH_SLACK_PX;
      if (isDetached !== (detachedSV.value === 1)) {
        detachedSV.value = isDetached ? 1 : 0;
        runOnJS(setDetached)(isDetached);
      }
    },
  });
  const onContentSizeChange = (_w: number, h: number) => {
    contentH.value = h;
    // Streaming text grows the content every few frames; while the reader is
    // at (or near) the live end, keep them pinned there. A reader who has
    // scrolled up to consult history is never yanked — the ↓ chip waits.
    if (stickRef.current) {
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
    }
  };
  const onScrollViewLayout = (e: LayoutChangeEvent) => { viewH.value = e.nativeEvent.layout.height; };
  const jumpToLatest = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
    setDetached(false);
  }, [scrollRef, setDetached]);

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

  // A tap on the live translation interrupts the turn (PTT) or skips the
  // rest of the readback (HF) — the half-duplex lock needs a door-open
  // button once the machine holds the floor.
  const interruptible =
    onInterrupt !== undefined &&
    (incomingStage === 'translating' || incomingStage === 'speaking');

  // Live hands-free partial — the words appear on the speaker's own half
  // while they are still talking, so a long turn never looks like a dead
  // phone. Attribution comes from the text classifier's live guess.
  const hfLiveHere =
    conversationMode === 'hf' &&
    activeTurn === null &&
    hfLive !== null &&
    hfLive.side === speakerId &&
    hfLive.text.length > 0;

  const sourceNode = hfLiveHere ? (
    <SourceLine label={speakerLang.endonym} text={tailOf(hfLive.text, 110)} />
  ) : activeTurn !== null && ownSource.length > 0 ? (
    <SourceLine label={speakerLang.endonym} text={ownSource} />
  ) : activeTurn === null && partnerSource.length > 0 && hasHero ? (
    <SourceLine label={partnerLang.endonym} text={partnerSource} />
  ) : null;

  return (
    <View style={styles.root}>
      <View style={styles.sourceSlot}>{sourceNode}</View>

      <View style={[styles.big, feed.length > 0 && styles.bigWithText]}>
        <Animated.ScrollView
          ref={scrollRef}
          onScroll={scrollHandler}
          onContentSizeChange={onContentSizeChange}
          onLayout={onScrollViewLayout}
          scrollEventThrottle={16}
          style={styles.bigScroll}
          contentContainerStyle={styles.bigScrollContent}
          showsVerticalScrollIndicator={false}
          bounces={false}>
          {feed.map((item, idx) =>
            idx === lastPartnerIdx ? (
              <Pressable
                key={item.id}
                onPress={interruptible ? onInterrupt : undefined}
                disabled={!interruptible}
                accessibilityRole={interruptible ? 'button' : undefined}
                accessibilityLabel={interruptible ? 'Stop this translation' : undefined}>
                <Animated.Text style={[styles.bigText, heroFontFor(heroLen), bigStyle]}>
                  {item.text}
                </Animated.Text>
              </Pressable>
            ) : (
              <HistoryLine key={item.id} kind={item.kind} text={item.text} />
            ),
          )}
          {feed.length === 0 && firstRun && !activeTurn && !firstHfRun && (
            <View style={styles.welcome}>
              <Text variant="serifHero" tone="fgFaint" style={styles.welcomeHeadline}>
                {t.holdToSpeak}
              </Text>
              <View style={styles.welcomeFlow}>
                <Text variant="serifSmall" tone="fgMuted">
                  {speakerLang.endonym.toUpperCase()}
                </Text>
                <Text variant="serifSmall" tone="fgMuted" style={styles.welcomeFlowArrow}>
                  →
                </Text>
                <Text variant="serifSmall" tone="fgMuted">
                  {partnerLang.endonym.toUpperCase()}
                </Text>
              </View>
            </View>
          )}
          {feed.length === 0 && firstHfRun && !activeTurn && (
            <View style={styles.welcome}>
              <Text variant="serifHero" tone="fgFaint" style={styles.welcomeHeadline}>
                {t.justSpeak}
              </Text>
              <Text variant="serifSmall" tone="fgMuted" style={styles.welcomeHfHint}>
                {t.tapToExit}
              </Text>
            </View>
          )}
          {notice !== null && (
            <Text
              variant="body"
              tone={notice.kind === 'error' ? 'error' : 'fgMuted'}
              style={styles.noticeText}>
              {notice.kind === 'error' ? '⚠  ' : ''}
              {noticeText(speakerLanguage, notice)}
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
        {detached && (
          <Pressable
            style={styles.jumpChip}
            onPress={jumpToLatest}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Jump to latest">
            <RNText style={styles.jumpArrow}>↓</RNText>
          </Pressable>
        )}
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
        {hfUnroutedHere && (
          <Text variant="serif" tone="fgMuted" style={styles.microcopy}>
            {t.unrouted}
          </Text>
        )}
        {hfLiveHere && !showMorph && (
          <Text variant="serif" tone="fgMuted" style={styles.microcopy}>
            {t.listening}
          </Text>
        )}
        {showMorph && (
          <View style={styles.statusRow}>
            <Text variant="serif" tone="fgMuted" style={styles.microcopy}>
              {stageMicrocopy(stageForMorph, speakerLanguage)}
            </Text>
            <View style={styles.morphSlot}>
              <StateMorph stage={stageForMorph} accent={accent} size={18} />
            </View>
          </View>
        )}
      </View>

      <View style={styles.spacer} />

      <Animated.View style={[styles.buttonSlot, unroutedFadeStyle]}>
        <PTTButton
          label={speakerLanguage || '—'}
          languageName={speakerLang.name}
          accent={accent}
          accentRing={accentRing}
          active={activeTurn !== null}
          disabled={disabled}
          mode={discMode}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          onTap={onTap}
        />
      </Animated.View>

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
  },
  historyPartner: {
    fontFamily: font.sansFamily,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '300',
    letterSpacing: -0.2,
    color: color.fgMuted,
    marginBottom: space.md,
  },
  historyOwn: {
    marginBottom: space.md,
  },
  noticeText: {
    marginTop: space.sm,
  },
  jumpChip: {
    position: 'absolute',
    right: 0,
    bottom: space.xs,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: color.bgElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  jumpArrow: {
    color: color.fgMuted,
    fontSize: 15,
    lineHeight: 18,
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
