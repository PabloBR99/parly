// LanguagePickerSheet — bottom-sheet language picker.
//
// Implementation: an in-screen overlay (NOT a native <Modal>), animated by
// Reanimated. The sheet is always mounted; opening/closing translates it
// in and out via a shared value. We chose this over the platform Modal
// because the Modal's Android Dialog window kept producing a visible
// upward jump whenever the user touched the sheet — multiple iterations
// of fixes inside the Modal couldn't make the slide stable. An in-screen
// overlay sidesteps the entire native Dialog layer.
//
// Two earlier risks we explicitly handle:
//   1) JNI crash from a previous Reanimated-on-Modal layering — that race
//      doesn't apply here because the views are never unmounted; we only
//      translate them off-screen on close.
//   2) Bottom-anchored content shifting when its measured height changed
//      mid-animation — we cache the exclude-language during render via a
//      ref so the list stays byte-identical through close.
//
// Behaviour:
//   - Backdrop fades + sheet rises when `visible` flips to true.
//   - Tapping a row → onSelect(code).
//   - Tapping the backdrop or the pull handle → onClose().

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './Text';
import { color, radius, space } from '../theme';
import { haptics } from '../haptics';
import { LANGUAGES } from '../../app/languages';
import { log } from '../../services/log/logStore';
import type { Language } from '../../app/types';

interface LanguagePickerSheetProps {
  readonly visible: boolean;
  readonly excludeCode?: string;     // hide language already used by the other slot
  readonly onSelect: (code: string) => void;
  readonly onClose: () => void;
}

const SCRIPT_GROUPS: { readonly title: string; readonly codes: readonly string[] }[] = [
  {
    title: 'Latin',
    codes: ['es', 'en', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'cs', 'tr', 'sv', 'no', 'da', 'fi', 'ro', 'hu', 'sw', 'vi', 'id'],
  },
  { title: 'Cyrillic', codes: ['ru', 'uk'] },
  { title: 'Greek', codes: ['el'] },
  { title: 'Arabic / Hebrew', codes: ['ar', 'he', 'fa', 'ur'] },
  { title: 'Devanagari / Bengali', codes: ['hi', 'bn'] },
  { title: 'CJK', codes: ['zh', 'ja', 'ko'] },
  { title: 'Thai', codes: ['th'] },
];

// Off-screen distance used to park the sheet when not visible. Using the
// full screen height guarantees the sheet is fully out of view regardless
// of its measured height.
const SCREEN_HEIGHT = Dimensions.get('window').height;

const SLIDE_IN_MS = 320;
const SLIDE_OUT_MS = 260;

export function LanguagePickerSheet({
  visible,
  excludeCode,
  onSelect,
  onClose,
}: LanguagePickerSheetProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState('');

  // Snapshot `excludeCode` during render via a ref. An effect would update
  // AFTER the first paint, briefly rendering with the exclude not applied,
  // which the bottom-anchored sheet translates into a top-edge jump.
  const cachedExcludeRef = useRef<string | undefined>(excludeCode);
  if (visible) {
    cachedExcludeRef.current = excludeCode;
  }
  const frozenExclude = cachedExcludeRef.current;

  // Reset the search filter on the false → true transition only. Closing
  // keeps the filter so the list size doesn't change mid-slide-out.
  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setFilter('');
    }
    wasVisibleRef.current = visible;
  }, [visible]);

  // ── Slide + fade animation ────────────────────────────────────────────────
  // translateY: SCREEN_HEIGHT (parked) → 0 (in place). Initial value parks
  // the sheet off-screen on first mount so it doesn't flash visible.
  const translateY = useSharedValue(SCREEN_HEIGHT);
  const backdropOpacity = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      translateY.value = withTiming(0, { duration: SLIDE_IN_MS });
      backdropOpacity.value = withTiming(0.62, { duration: SLIDE_IN_MS });
    } else {
      translateY.value = withTiming(SCREEN_HEIGHT, { duration: SLIDE_OUT_MS });
      backdropOpacity.value = withTiming(0, { duration: SLIDE_OUT_MS });
    }
  }, [visible, translateY, backdropOpacity]);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  // ── List composition ──────────────────────────────────────────────────────
  const filterLower = filter.trim().toLowerCase();

  const groups = useMemo(() => {
    return SCRIPT_GROUPS.map(g => {
      const codes = g.codes
        .filter(c => c !== frozenExclude)
        .map(c => LANGUAGES.find(l => l.code === c))
        .filter((l): l is Language => l !== undefined)
        .filter(l => {
          if (filterLower === '') return true;
          return (
            l.name.toLowerCase().includes(filterLower) ||
            l.endonym.toLowerCase().includes(filterLower) ||
            l.code.toLowerCase().includes(filterLower)
          );
        });
      return { ...g, languages: codes };
    }).filter(g => g.languages.length > 0);
  }, [frozenExclude, filterLower]);

  return (
    // Outer wrapper — absoluteFill within parent. pointerEvents toggles on
    // visibility so taps pass through to underlying UI when the sheet is
    // closed (it's still mounted and laid out).
    <View
      style={StyleSheet.absoluteFillObject}
      pointerEvents={visible ? 'auto' : 'none'}>
      {/* Backdrop — Reanimated opacity from 0 → 0.62. */}
      <Animated.View
        pointerEvents={visible ? 'auto' : 'none'}
        style={[styles.backdrop, backdropStyle]}>
        <Pressable
          style={StyleSheet.absoluteFillObject}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close picker"
        />
      </Animated.View>

      {/* Sheet — fixed-height bottom-anchored panel. translateY drives the
          slide. Height is a percentage of the parent so the sheet adapts
          when the keyboard opens (Android adjustResize shrinks the parent),
          but the LAYOUT never depends on the inner content's measured size. */}
      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: insets.bottom + space.md },
          sheetStyle,
        ]}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={8}>
          <View style={styles.handle} />
        </Pressable>
        <View style={styles.searchWrap}>
          <Text variant="caption" tone="fgFaint" style={styles.searchLabel}>
            CHOOSE LANGUAGE
          </Text>
          <TextInput
            style={styles.search}
            placeholder="Search — English, Español, 日本語…"
            placeholderTextColor={color.fgGhost}
            value={filter}
            onChangeText={setFilter}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.list}>
          {groups.map(g => (
            <View key={g.title} style={styles.group}>
              <Text variant="caption" tone="fgGhost" style={styles.groupTitle}>
                {g.title.toUpperCase()}
              </Text>
              {g.languages.map(l => (
                <LanguageRow key={l.code} language={l} onPress={() => onSelect(l.code)} />
              ))}
            </View>
          ))}
          {groups.length === 0 && (
            <Text variant="body" tone="fgFaint" style={styles.empty}>
              No matches.
            </Text>
          )}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function LanguageRow({
  language,
  onPress,
}: {
  readonly language: Language;
  readonly onPress: () => void;
}): React.JSX.Element {
  const handle = () => {
    log.info(`[picker] row tap code=${language.code} name=${language.name}`);
    haptics.tick();
    onPress();
  };
  return (
    <Pressable
      onPress={handle}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={`Choose ${language.name}`}>
      <Text style={styles.rowEmoji}>{language.emoji}</Text>
      <View style={styles.rowText}>
        <Text variant="body" tone="fg">{language.endonym}</Text>
        <Text variant="bodySmall" tone="fgFaint">{language.name}</Text>
      </View>
      <Text variant="serifSmall" tone="fgGhost">{language.code.toLowerCase()}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'black',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '88%',
    backgroundColor: '#0B0B0B',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: color.hairline,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.fgGhost,
    marginTop: space.sm,
    marginBottom: space.md,
  },
  searchWrap: {
    paddingHorizontal: space.xl,
    paddingBottom: space.md,
  },
  searchLabel: {
    marginBottom: space.xs,
  },
  search: {
    backgroundColor: color.surface1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    color: color.fg,
    fontSize: 15,
  },
  list: {
    paddingHorizontal: space.md,
    paddingBottom: space.xl,
  },
  group: {
    marginBottom: space.md,
  },
  groupTitle: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    marginBottom: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: 12,
    borderRadius: radius.md,
  },
  rowPressed: {
    backgroundColor: color.surface2,
  },
  rowEmoji: {
    fontSize: 22,
    marginRight: space.md,
  },
  rowText: {
    flex: 1,
  },
  empty: {
    textAlign: 'center',
    paddingVertical: space.xl,
  },
});
