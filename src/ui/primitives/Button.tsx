// Button — primary / secondary / danger variants.

import React from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Text } from './Text';
import { color, motion, radius, space } from '../theme';
import { haptics } from '../haptics';

interface ButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  readonly disabled?: boolean;
  readonly style?: ViewStyle;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  style,
}: ButtonProps): React.JSX.Element {
  const press = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - 0.025 * press.value }],
  }));

  const handle = () => {
    if (disabled) return;
    haptics.tap();
    onPress();
  };

  const variantStyle = variantStyles[variant];
  const disabledStyle = disabled ? variantStyles[`${variant}Disabled`] : null;

  return (
    <Pressable
      onPressIn={() => { press.value = withSpring(1, motion.springSnappy); }}
      onPressOut={() => { press.value = withSpring(0, motion.springSnappy); }}
      onPress={handle}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}>
      <Animated.View style={[styles.base, variantStyle, disabledStyle, animatedStyle, style]}>
        <Text
          variant="button"
          tone={
            disabled
              ? 'fgGhost'
              : variant === 'primary'
              ? 'fgInk'
              : variant === 'danger'
              ? 'error'
              : 'fg'
          }>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
});

const variantStyles = StyleSheet.create({
  primary: { backgroundColor: color.fg },
  primaryDisabled: { backgroundColor: color.surface1 },
  secondary: {
    backgroundColor: color.surface2,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  secondaryDisabled: {
    backgroundColor: color.surface1,
    borderColor: color.hairline,
    opacity: 0.5,
  },
  danger: {
    backgroundColor: color.errorSoft,
    borderWidth: 1,
    borderColor: color.errorBorder,
  },
  dangerDisabled: { opacity: 0.4 },
  ghost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: color.hairline,
  },
  ghostDisabled: { opacity: 0.4 },
});

// Tiny visual divider used inside Settings cards.
export function Divider({ inset = 0 }: { readonly inset?: number }): React.JSX.Element {
  return <View style={[dividerStyles.line, { marginHorizontal: inset }]} />;
}

const dividerStyles = StyleSheet.create({
  line: { height: StyleSheet.hairlineWidth, backgroundColor: color.hairline },
});
