// LanguagePickerSheet — modal bottom sheet for picking a language.
//
// Behavior:
//   - Backdrop fades in from 0 → 0.55 over 220ms.
//   - Sheet rises 100% → 0 with a soft spring.
//   - Search bar at top; below: scrollable list grouped by script family.
//   - Tap a row → onSelect(code) → caller closes sheet.
//   - Tap backdrop or pull-down handle → onClose().
//
// We don't use a native Modal — RN's Modal on Android has subtle status-bar
// flicker issues and we want full motion control. Instead it's an
// absolutely-positioned overlay rendered into a Portal-less tree (the
// caller toggles its visibility).

import React, { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './Text';
import { color, motion, radius, space } from '../theme';
import { LANGUAGES } from '../../app/languages';
import type { Language } from '../../app/types';

interface LanguagePickerSheetProps {
  readonly visible: boolean;
  readonly excludeCode?: string;     // hide language already used by the other slot
  readonly onSelect: (code: string) => void;
  readonly onClose: () => void;
}

// Script-family grouping — gives the picker an editorial, respectful structure.
// Ordered by how close to the user's likely diplomatic context they are.
const SCRIPT_GROUPS: { readonly title: string; readonly codes: readonly string[] }[] = [
  {
    title: 'Latina',
    codes: ['es', 'en', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'cs', 'tr', 'sv', 'no', 'da', 'fi', 'ro', 'hu', 'sw', 'vi', 'id'],
  },
  {
    title: 'Cirílica',
    codes: ['ru', 'uk'],
  },
  {
    title: 'Griega',
    codes: ['el'],
  },
  {
    title: 'Árabe / Hebrea',
    codes: ['ar', 'he', 'fa', 'ur'],
  },
  {
    title: 'Devanagari / Bengalí',
    codes: ['hi', 'bn'],
  },
  {
    title: 'CJK',
    codes: ['zh', 'ja', 'ko'],
  },
  {
    title: 'Tailandés',
    codes: ['th'],
  },
];

export function LanguagePickerSheet({
  visible,
  excludeCode,
  onSelect,
  onClose,
}: LanguagePickerSheetProps): React.JSX.Element | null {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState('');
  const [mounted, setMounted] = useState(visible);

  const opacity = useSharedValue(0);
  const translate = useSharedValue(1);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      opacity.value = withTiming(1, { duration: motion.normal, easing: Easing.out(Easing.quad) });
      translate.value = withTiming(0, { duration: motion.normal + 80, easing: Easing.out(Easing.cubic) });
    } else if (mounted) {
      opacity.value = withTiming(0, { duration: motion.fast, easing: Easing.in(Easing.quad) });
      translate.value = withTiming(1, {
        duration: motion.normal,
        easing: Easing.in(Easing.cubic),
      }, (finished) => {
        if (finished) runOnJS(setMounted)(false);
      });
    }
  }, [visible, mounted, opacity, translate]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: opacity.value * 0.6,
  }));

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: translate.value * 600 },
    ],
    opacity: opacity.value,
  }));

  const filterLower = filter.trim().toLowerCase();

  const groups = useMemo(() => {
    return SCRIPT_GROUPS.map(g => {
      const codes = g.codes
        .filter(c => c !== excludeCode)
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
  }, [excludeCode, filterLower]);

  if (!mounted) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Backdrop */}
      <Animated.View style={[styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Cerrar selector" />
      </Animated.View>

      {/* Sheet */}
      <Animated.View style={[styles.sheet, { paddingBottom: insets.bottom + space.md }, sheetStyle]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.kavoid}>
          <View style={styles.handle} />
          <View style={styles.searchWrap}>
            <Text variant="caption" tone="fgFaint" style={styles.searchLabel}>
              ELEGIR IDIOMA
            </Text>
            <TextInput
              style={styles.search}
              placeholder="Buscar — Español, English, 日本語…"
              placeholderTextColor={color.fgGhost}
              value={filter}
              onChangeText={setFilter}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
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
                Sin coincidencias.
              </Text>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
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
  const press = useSharedValue(0);
  const animated = useAnimatedStyle(() => ({
    backgroundColor: press.value > 0 ? color.surface2 : 'transparent',
  }));
  return (
    <Pressable
      onPressIn={() => { press.value = withTiming(1, { duration: 60 }); }}
      onPressOut={() => { press.value = withTiming(0, { duration: 120 }); }}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Elegir ${language.name}`}>
      <Animated.View style={[styles.row, animated]}>
        <Text style={styles.rowEmoji}>{language.emoji}</Text>
        <View style={styles.rowText}>
          <Text variant="body" tone="fg">{language.endonym}</Text>
          <Text variant="bodySmall" tone="fgFaint">{language.name}</Text>
        </View>
        <Text variant="mono" tone="fgGhost">{language.code.toUpperCase()}</Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '88%',
    backgroundColor: '#0B0B0B',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: color.hairline,
  },
  kavoid: {
    flex: 0,
    minHeight: 200,
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
