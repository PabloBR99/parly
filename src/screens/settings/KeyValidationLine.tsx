import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { KeyValidation } from '../../services/auth/validateApiKey';
import { Text } from '../../ui';

interface Props {
  readonly state: KeyValidation | null;
  readonly validating: boolean;
}

export function KeyValidationLine({ state, validating }: Props): React.JSX.Element {
  if (validating) {
    return (
      <Text variant="mono" tone="fgFaint" style={styles.keyStatus}>
        CHECKING…
      </Text>
    );
  }
  if (state === null) {
    return <View style={styles.keyStatus} />;
  }
  if (state.status === 'ok') {
    return (
      <Text variant="mono" tone="ok" style={styles.keyStatus}>
        ●  KEY VALID
      </Text>
    );
  }
  if (state.status === 'invalid') {
    return (
      <Text variant="mono" tone="error" style={styles.keyStatus}>
        ●  KEY REJECTED
      </Text>
    );
  }
  if (state.status === 'network') {
    return (
      <Text variant="mono" tone="warn" style={styles.keyStatus}>
        ●  NO NETWORK
      </Text>
    );
  }
  return (
    <Text variant="mono" tone="warn" style={styles.keyStatus}>
      ●  HTTP {state.httpStatus}
    </Text>
  );
}

const styles = StyleSheet.create({
  keyStatus: {
    flex: 1,
  },
});
