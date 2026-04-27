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
import { LANGUAGES } from '../../app/languages';
import type { Language } from '../../app/types';

interface LanguagePickerSheetProps {
  readonly visible: boolean;
  readonly excludeCode?: string;     // hide language already used by the other slot
  readonly onSelect: (code: string) => void;
  readonly onClose: () => void;
}

const SCRIPT_GROUPS: { readonly title: string; readonly codes: readonly string[] }[] = [
  {
    title: 'Latina',
    codes: ['es', 'en', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'cs', 'tr', 'sv', 'no', 'da', 'fi', 'ro', 'hu', 'sw', 'vi', 'id'],
  },
  { title: 'Cirílica', codes: ['ru', 'uk'] },
  { title: 'Griega', codes: ['el'] },
  { title: 'Árabe / Hebrea', codes: ['ar', 'he', 'fa', 'ur'] },
  { title: 'Devanagari / Bengalí', codes: ['hi', 'bn'] },
  { title: 'CJK', codes: ['zh', 'ja', 'ko'] },
  { title: 'Tailandés', codes: ['th'] },
];

export function LanguagePickerSheet({
  visible,
  excludeCode,
  onSelect,
  onClose,
}: LanguagePickerSheetProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState('');

  // Reset filter when sheet closes/reopens.
  useEffect(() => {
    if (!visible) setFilter('');
  }, [visible]);

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
          accessibilityLabel="Cerrar selector"
        />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + space.md }]}>
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
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={`Elegir ${language.name}`}>
      <Text style={styles.rowEmoji}>{language.emoji}</Text>
      <View style={styles.rowText}>
        <Text variant="body" tone="fg">{language.endonym}</Text>
        <Text variant="bodySmall" tone="fgFaint">{language.name}</Text>
      </View>
      <Text variant="mono" tone="fgGhost">{language.code.toUpperCase()}</Text>
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
