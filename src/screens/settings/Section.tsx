import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, space } from '../../ui';

interface SectionProps {
  readonly label: string;
  readonly children: React.ReactNode;
}

export function Section({ label, children }: SectionProps): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text variant="caption" tone="fgFaint" style={styles.sectionLabel}>
        {label}
      </Text>
      <View>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: space.xxl,
  },
  sectionLabel: {
    marginBottom: space.sm,
    letterSpacing: 1.8,
  },
});
