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
  return (
    <View style={styles.pill}>
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
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
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 8,
  },
  label: {},
});
