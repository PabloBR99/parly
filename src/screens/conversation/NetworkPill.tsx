import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, color } from '../../ui';

interface NetworkPillProps {
  readonly state: 'unknown' | 'online' | 'offline';
}

export function NetworkPill({ state }: NetworkPillProps): React.JSX.Element {
  const dotColor =
    state === 'online' ? color.ok :
    state === 'offline' ? color.error :
    color.fgGhost;
  const label =
    state === 'online' ? 'online' :
    state === 'offline' ? 'offline' :
    'connecting';
  // A soft halo behind the live dot — colour glows can't use box-shadow on
  // Android, so we layer a translucent disc. Only "online" glows (seafoam);
  // offline/connecting stay quiet so the glow always reads as "good".
  const showHalo = state === 'online';
  return (
    <View style={styles.pill}>
      <View style={styles.dotWrap}>
        {showHalo && <View style={[styles.halo, { backgroundColor: dotColor }]} />}
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
      </View>
      <Text variant="serif" tone="fgFaint" style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 0,
    paddingVertical: 4,
  },
  dotWrap: {
    width: 6,
    height: 6,
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    opacity: 0.45,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {},
});
