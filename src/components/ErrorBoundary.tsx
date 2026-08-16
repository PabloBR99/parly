import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, color, space } from '../ui';

interface Props {
  readonly children: React.ReactNode;
}

interface State {
  readonly hasError: boolean;
  readonly error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <View style={styles.root}>
          <Text variant="serifHero" tone="fg" style={styles.title}>
            Something went wrong.
          </Text>
          <Text variant="body" tone="fgMuted" style={styles.message}>
            {this.state.error?.message ?? 'Unknown error'}
          </Text>
          <Text variant="bodySmall" tone="fgFaint" style={styles.hint}>
            Restart the app to continue.
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xxl,
  },
  title: { marginBottom: space.md, textAlign: 'center' },
  message: { marginBottom: space.lg, textAlign: 'center' },
  hint: { textAlign: 'center' },
});
