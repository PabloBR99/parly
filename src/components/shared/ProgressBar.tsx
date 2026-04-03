import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

interface Props {
  readonly progress: number; // 0-100
}

export function ProgressBar({ progress }: Props): React.JSX.Element {
  const fillStyle = useMemo(
    () => [styles.fill, { width: `${Math.min(100, Math.max(0, progress))}%` as const }],
    [progress],
  );

  return (
    <View style={styles.track}>
      <View style={fillStyle} />
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
