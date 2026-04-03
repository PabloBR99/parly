import React from 'react';
import { StyleSheet, View } from 'react-native';

interface Props {
  readonly progress: number; // 0-100
}

export function ProgressBar({ progress }: Props): React.JSX.Element {
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${Math.min(100, Math.max(0, progress))}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 4,
    backgroundColor: '#374151',
    borderRadius: 2,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: '#2563eb',
    borderRadius: 2,
  },
});
