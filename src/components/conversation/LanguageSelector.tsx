import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  FlatList,
  View,
} from 'react-native';
import { LANGUAGES, getLanguage } from '../../app/languages';
import type { Language } from '../../app/types';
import { getUiStrings } from '../../i18n/uiStrings';

interface Props {
  readonly value: string;
  readonly onChange: (code: string) => void;
  readonly lang?: string;
  readonly inverted?: boolean;
}

export function LanguageSelector({ value, onChange, lang, inverted }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const current = getLanguage(value);
  const s = getUiStrings(lang ?? value);

  const filtered = useMemo(
    () => search
      ? LANGUAGES.filter(l =>
          l.name.toLowerCase().includes(search.toLowerCase()) ||
          l.code.toLowerCase().includes(search.toLowerCase()),
        )
      : LANGUAGES,
    [search],
  );

  function select(selected: Language): void {
    onChange(selected.code);
    setOpen(false);
    setSearch('');
  }

  return (
    <>
      <Pressable style={styles.trigger} onPress={() => setOpen(true)}>
        <Text style={styles.flag}>{current.flag}</Text>
        <Text style={styles.name}>{current.name}</Text>
        <Text style={styles.chevron}>{'\u203A'}</Text>
      </Pressable>

      <Modal visible={open} transparent animationType={inverted ? 'fade' : 'slide'}>
        <View style={[styles.backdrop, inverted && styles.backdropInverted]}>
          <View style={[styles.sheet, inverted && styles.sheetInverted]}>
            <TextInput
              style={styles.search}
              placeholder={s.searchLanguage}
              placeholderTextColor="rgba(255,255,255,0.25)"
              value={search}
              onChangeText={setSearch}
              autoFocus
            />
            <FlatList
              data={filtered as Language[]}
              keyExtractor={l => l.code}
              renderItem={({ item }) => (
                <Pressable style={styles.item} onPress={() => select(item)}>
                  <Text style={styles.itemFlag}>{item.flag}</Text>
                  <Text style={styles.itemName}>{item.name}</Text>
                  {item.code === value && <Text style={styles.check}>{'\u2713'}</Text>}
                </Pressable>
              )}
            />
            <Pressable style={styles.closeBtn} onPress={() => setOpen(false)}>
              <Text style={styles.closeTxt}>{s.cancel}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  flag: { fontSize: 22 },
  name: { fontSize: 15, color: 'rgba(255,255,255,0.85)', fontWeight: '500' },
  chevron: { fontSize: 18, color: 'rgba(255,255,255,0.25)', marginLeft: 2 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  backdropInverted: {
    justifyContent: 'flex-start',
  },
  sheet: {
    backgroundColor: '#0d0d0d',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '70%',
    paddingBottom: 20,
  },
  sheetInverted: {
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
    transform: [{ rotate: '180deg' }],
  },
  search: {
    margin: 16,
    backgroundColor: '#161616',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: 'rgba(255,255,255,0.85)',
    fontSize: 15,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 12,
  },
  itemFlag: { fontSize: 24 },
  itemName: { flex: 1, fontSize: 16, color: 'rgba(255,255,255,0.85)' },
  check: { fontSize: 18, color: 'rgba(255,255,255,0.70)' },
  closeBtn: {
    marginTop: 8,
    marginHorizontal: 16,
    backgroundColor: '#161616',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  closeTxt: { color: 'rgba(255,255,255,0.50)', fontSize: 16, fontWeight: '600' },
});
