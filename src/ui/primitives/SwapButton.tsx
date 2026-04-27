// SwapButton — the ⇅ between the two language cards. Press triggers a
// ½-rotation that visually expresses the swap without needing a separate
// transition on the cards themselves (which would be tricky given each
// card holds its own dynamic content).

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Text } from './Text';
import { color, motion, radius } from '../theme';
import { haptics } from '../haptics';

interface SwapButtonProps {
  readonly disabled: boolean;
  readonly onPress: () => void;
}

export function SwapButton({ disabled, onPress }: SwapButtonProps): React.JSX.Element {
  const rot = useSharedValue(0);
  const press = useSharedValue(0);

  const animated = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${rot.value}deg` },
      { scale: 1 - 0.06 * press.value },
    ],
  }));

  const handle = () => {
    if (disabled) return;
    haptics.tick();
    rot.value = withTiming(rot.value + 180, { duration: motion.normal });
    onPress();
  };

  return (
    <View style={styles.row}>
      <Pressable
        onPressIn={() => { press.value = withSpring(1, motion.springSnappy); }}
        onPressOut={() => { press.value = withSpring(0, motion.springSnappy); }}
        onPress={handle}
        disabled={disabled}
        hitSlop={16}
        accessibilityRole="button"
        accessibilityLabel="Swap languages"
        accessibilityState={{ disabled }}>
        <Animated.View style={[styles.btn, animated, disabled && styles.btnDisabled]}>
          <Text variant="body" tone={disabled ? 'fgGhost' : 'fgMuted'} style={styles.glyph}>
            ⇅
          </Text>
        </Animated.View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  btn: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  btnDisabled: {
    opacity: 0.4,
  },
  glyph: {
    fontSize: 16,
  },
});
