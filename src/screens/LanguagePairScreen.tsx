// LanguagePairScreen — first screen, "Handoff" pattern.
//
// Design intent (diplomatic demo):
//   The selection IS the conversation surface. Two empty speech bubbles
//   facing each other; a horizontal rail of language chips below. Tap a
//   chip → it fills the first empty bubble (top first, then bottom). Tap
//   a filled bubble → it returns the chip to the rail. A small ⇅ between
//   the bubbles swaps them.
//
//   Why not drag-drop?
//     A failed drag in front of an audience is embarrassing and the
//     gesture is unfamiliar to non-technical users. Tap-to-fill is the
//     only path the politician needs to know — single tap, unambiguous.
//     The bubbles' "next empty" affordance is communicated by a soft
//     ring around the active target.
//
//   Why endonyms (native script names)?
//     A diplomat with a Cyrillic background reads "Русский" faster than
//     "Russian". And it telegraphs respect — "your language as you
//     write it" — which suits the use case.

import React, { useMemo, useState } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSettingsStore } from '../store/settingsStore';
import { LANGUAGES, getLanguage } from '../app/languages';
import type { Language } from '../app/types';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'LanguagePair'>;

type Slot = 'top' | 'bottom';

export function LanguagePairScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const personA = useSettingsStore(s => s.personA);
  const personB = useSettingsStore(s => s.personB);
  const setPersonLanguage = useSettingsStore(s => s.setPersonLanguage);
  const setLanguagePairConfigured = useSettingsStore(s => s.setLanguagePairConfigured);

  // Top bubble = personB (the other person), bottom = personA (you).
  const topCode = personB.language;
  const bottomCode = personA.language;
  const bothFilled = topCode !== '' && bottomCode !== '';

  const [filter, setFilter] = useState('');
  const filterLower = filter.trim().toLowerCase();
  const filteredLanguages = useMemo<readonly Language[]>(() => {
    if (filterLower === '') return LANGUAGES;
    return LANGUAGES.filter(
      l =>
        l.name.toLowerCase().includes(filterLower) ||
        l.endonym.toLowerCase().includes(filterLower) ||
        l.code.toLowerCase().includes(filterLower),
    );
  }, [filterLower]);

  const nextEmptySlot: Slot | null =
    topCode === '' ? 'top' : bottomCode === '' ? 'bottom' : null;

  const assignToNextEmpty = (code: string) => {
    if (nextEmptySlot === 'top') setPersonLanguage('B', code);
    else if (nextEmptySlot === 'bottom') setPersonLanguage('A', code);
    // If both filled and user taps a chip, replace the most recently filled
    // (bottom). This matches the "tap a bubble to clear" + "tap chip again"
    // pattern without modal state.
    else setPersonLanguage('A', code);
  };

  const clearSlot = (slot: Slot) => {
    if (slot === 'top') setPersonLanguage('B', '');
    else setPersonLanguage('A', '');
  };

  const swap = () => {
    if (topCode === '' || bottomCode === '') return;
    setPersonLanguage('B', bottomCode);
    setPersonLanguage('A', topCode);
  };

  const onStart = () => {
    if (!bothFilled) return;
    setLanguagePairConfigured(true);
    navigation.replace('Conversation');
  };

  const usedCodes = new Set([topCode, bottomCode].filter(c => c !== ''));
  const railLanguages = filteredLanguages.filter(l => !usedCodes.has(l.code));

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Idiomas</Text>
        <Text style={styles.subtitle}>
          Toca un idioma para asignarlo. Toca una burbuja para liberarla.
        </Text>
      </View>

      {/* TOP BUBBLE — other person's language */}
      <Bubble
        slot="top"
        code={topCode}
        active={nextEmptySlot === 'top'}
        onClear={() => clearSlot('top')}
      />

      {/* SWAP affordance */}
      <Pressable
        style={styles.swap}
        onPress={swap}
        disabled={!bothFilled}
        accessibilityRole="button"
        accessibilityLabel="Intercambiar idiomas"
        accessibilityState={{ disabled: !bothFilled }}>
        <Text style={[styles.swapGlyph, !bothFilled && styles.swapGlyphMuted]}>
          ⇅
        </Text>
      </Pressable>

      {/* BOTTOM BUBBLE — your language */}
      <Bubble
        slot="bottom"
        code={bottomCode}
        active={nextEmptySlot === 'bottom'}
        onClear={() => clearSlot('bottom')}
      />

      {/* Search filter */}
      <View style={styles.search}>
        <TextInput
          style={styles.searchInput}
          placeholder="Buscar idioma…"
          placeholderTextColor="rgba(255,255,255,0.3)"
          value={filter}
          onChangeText={setFilter}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {/* Language rail */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rail}
        keyboardShouldPersistTaps="handled">
        {railLanguages.map(lang => (
          <LanguageChip
            key={lang.code}
            language={lang}
            onPress={() => assignToNextEmpty(lang.code)}
          />
        ))}
        {railLanguages.length === 0 && (
          <Text style={styles.empty}>Sin coincidencias</Text>
        )}
      </ScrollView>

      {/* Continue */}
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <Pressable
          style={[styles.startBtn, !bothFilled && styles.startBtnDisabled]}
          onPress={onStart}
          disabled={!bothFilled}
          accessibilityRole="button"
          accessibilityLabel="Empezar conversación">
          <Text style={[styles.startLabel, !bothFilled && styles.startLabelDisabled]}>
            Empezar
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── Bubble ───────────────────────────────────────────────────────────────────

interface BubbleProps {
  readonly slot: Slot;
  readonly code: string;
  readonly active: boolean;
  readonly onClear: () => void;
}

function Bubble({ slot, code, active, onClear }: BubbleProps): React.JSX.Element {
  const lang = code === '' ? null : getLanguage(code);

  // Subtle scale animation when active
  const scale = React.useRef(new Animated.Value(1)).current;
  React.useEffect(() => {
    Animated.spring(scale, {
      toValue: active ? 1.02 : 1,
      useNativeDriver: true,
      friction: 6,
      tension: 50,
    }).start();
  }, [active, scale]);

  const tailStyle = slot === 'top' ? styles.bubbleTailTop : styles.bubbleTailBottom;

  return (
    <View style={styles.bubbleRow}>
      <Animated.View
        style={[
          styles.bubble,
          active && styles.bubbleActive,
          lang !== null && styles.bubbleFilled,
          { transform: [{ scale }] },
        ]}>
        {lang === null ? (
          <Text style={styles.bubblePlaceholder}>
            {slot === 'top' ? 'Su idioma' : 'Tu idioma'}
          </Text>
        ) : (
          <Pressable
            onPress={onClear}
            accessibilityRole="button"
            accessibilityLabel={`Quitar ${lang.name}`}>
            <Text style={styles.bubbleEmoji}>{lang.emoji}</Text>
            <Text style={styles.bubbleEndonym}>{lang.endonym}</Text>
            <Text style={styles.bubbleName}>{lang.name}</Text>
          </Pressable>
        )}
      </Animated.View>
      <View style={[styles.bubbleTail, tailStyle]} />
    </View>
  );
}

// ── Chip ─────────────────────────────────────────────────────────────────────

interface ChipProps {
  readonly language: Language;
  readonly onPress: () => void;
}

function LanguageChip({ language, onPress }: ChipProps): React.JSX.Element {
  return (
    <Pressable
      style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Asignar ${language.name}`}>
      <Text style={styles.chipEmoji}>{language.emoji}</Text>
      <Text style={styles.chipEndonym}>{language.endonym}</Text>
    </Pressable>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  header: { paddingHorizontal: 28, paddingTop: 24, paddingBottom: 18 },
  title: { color: 'rgba(255,255,255,0.95)', fontSize: 28, fontWeight: '300', letterSpacing: -0.5 },
  subtitle: { color: 'rgba(255,255,255,0.45)', fontSize: 13, marginTop: 6 },

  bubbleRow: { paddingHorizontal: 24, marginVertical: 6 },
  bubble: {
    minHeight: 92,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 22,
    paddingVertical: 18,
    paddingHorizontal: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubbleActive: {
    borderColor: 'rgba(255,255,255,0.30)',
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  bubbleFilled: {
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderColor: 'rgba(255,255,255,0.16)',
  },
  bubblePlaceholder: { color: 'rgba(255,255,255,0.35)', fontSize: 16, fontWeight: '300' },
  bubbleEmoji: { fontSize: 22, textAlign: 'center', marginBottom: 4 },
  bubbleEndonym: {
    color: 'rgba(255,255,255,0.95)',
    fontSize: 22,
    fontWeight: '400',
    textAlign: 'center',
  },
  bubbleName: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 2,
    letterSpacing: 0.5,
  },
  bubbleTail: {
    width: 12,
    height: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    transform: [{ rotate: '45deg' }],
    alignSelf: 'center',
    marginTop: -6,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  bubbleTailTop: {},
  bubbleTailBottom: { marginTop: -6, marginBottom: 0 },

  swap: { alignSelf: 'center', paddingVertical: 4, paddingHorizontal: 16 },
  swapGlyph: { color: 'rgba(255,255,255,0.55)', fontSize: 18 },
  swapGlyphMuted: { color: 'rgba(255,255,255,0.15)' },

  search: { paddingHorizontal: 24, marginTop: 14, marginBottom: 8 },
  searchInput: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    color: 'rgba(255,255,255,0.92)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },

  rail: { paddingHorizontal: 18, paddingVertical: 8, alignItems: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    marginHorizontal: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  chipPressed: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderColor: 'rgba(255,255,255,0.20)',
  },
  chipEmoji: { fontSize: 16, marginRight: 8 },
  chipEndonym: { color: 'rgba(255,255,255,0.92)', fontSize: 14 },
  empty: { color: 'rgba(255,255,255,0.4)', paddingHorizontal: 16 },

  footer: { paddingHorizontal: 24, paddingTop: 12 },
  startBtn: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 18,
    paddingVertical: 16,
    alignItems: 'center',
  },
  startBtnDisabled: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  startLabel: { color: '#000', fontSize: 16, fontWeight: '500', letterSpacing: 0.3 },
  startLabelDisabled: { color: 'rgba(255,255,255,0.3)' },
});
