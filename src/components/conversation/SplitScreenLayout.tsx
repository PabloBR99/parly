import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface Props {
  readonly topPanel: React.ReactNode;
  readonly bottomPanel: React.ReactNode;
}

export function SplitScreenLayout({ topPanel, bottomPanel }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.container}>
      {/* Top half — rotated 180° for the person sitting across the table */}
      <View
        style={[
          styles.panel,
          styles.topPanel,
          { paddingBottom: insets.top },
        ]}>
        <View style={styles.rotated}>{topPanel}</View>
      </View>

      {/* Divider */}
      <View style={styles.divider} />

      {/* Bottom half — normal orientation for the person holding the phone */}
      <View
        style={[
          styles.panel,
          styles.bottomPanel,
          { paddingBottom: insets.bottom },
        ]}>
        {bottomPanel}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f0f',
  },
  panel: {
    flex: 1,
  },
  topPanel: {
    backgroundColor: '#111827',
  },
  bottomPanel: {
    backgroundColor: '#111827',
  },
  divider: {
    height: 2,
    backgroundColor: '#374151',
  },
  rotated: {
    flex: 1,
    transform: [{ rotate: '180deg' }],
  },
});
