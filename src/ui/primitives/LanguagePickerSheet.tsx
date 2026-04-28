// LanguagePickerSheet — modal bottom sheet for picking a language.
//
// Behavior:
//   - Backdrop fades + sheet rises when `visible` flips to true (native Modal slide).
//   - Tapping a row → onSelect(code).
//   - Tapping backdrop or pull-down handle → onClose().
//
// Implementation note: we deliberately use the platform <Modal> with its
// native `animationType="slide"` and NO Reanimated entrance/exit. An earlier
// version layered a Reanimated `useAnimatedStyle` over the Modal — on Android,
// when the user tapped a row the parent flipped `visible=false` while a
// trailing Reanimated useEffect tried to write shared values into views that
// the Modal had already begun tearing down, producing a hard JNI crash. The
// purely-native path eliminates that race.

import React, { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
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

export function LanguagePickerSheet({
  visible,
  excludeCode,
  onSelect,
  onClose,
}: LanguagePickerSheetProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState('');

  // Both `frozenExclude` and the search filter are reset ON OPEN, never on
  // close. The sheet is bottom-anchored (position:absolute; bottom:0) so any
  // change to its content height during the close animation translates into
  // an UPWARD jump of the top edge — exactly the erratic motion the user
  // reported. By only mutating these on open, the list stays byte-identical
  // through the entire slide-down, and the close reads as a clean drop.
  const [frozenExclude, setFrozenExclude] = useState(excludeCode);
  useEffect(() => {
    if (visible) {
      setFrozenExclude(excludeCode);
      setFilter('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

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
    <Modal
      visible={visible}
      onRequestClose={onClose}
      transparent
      animationType="slide"
      statusBarTranslucent>
      <View style={styles.fill} pointerEvents="box-none">
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close picker"
        />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + space.md }]}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.kavoid}>
            <View style={styles.handle} />
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
          </KeyboardAvoidingView>
        </View>
      </View>
    </Modal>
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
  fill: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.62)',
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
    minHeight: 240,
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
