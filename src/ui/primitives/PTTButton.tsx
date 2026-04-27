// PTTButton — push-to-talk control with active-ring + waveform pulse.
//
// Visual states:
//   idle     → soft circle, language code in mono, dim
//   pressed  → grows ~6%, ring expands, ring opacity rises
//   active   → recording: outer ring breathes outward continuously,
//              waveform inside the disk
//   disabled → 35% opacity, no interaction
//
// Behaviour: hold-to-talk. onPressIn fires beginTurn, onPressOut fires
// endTurn — same contract as the existing screen, just a refined surface.

import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Text } from './Text';
import { color, motion, radius } from '../theme';
import { Waveform } from '../animations/Waveform';
import { haptics } from '../haptics';

interface PTTButtonProps {
  readonly label: string;        // language code in caps, e.g. "ES"
  readonly accent: string;       // accent color (Person A or B)
  readonly accentRing: string;   // accent ring tint (translucent)
  readonly active: boolean;      // currently recording
  readonly disabled: boolean;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
  /** Inverted = render upside-down (used on the top half of the conversation
   *  surface so the counterparty sitting across the table reads upright). */
  readonly inverted?: boolean;
}

const SIZE = 84;

export function PTTButton({
  label,
  accent,
  accentRing,
  active,
  disabled,
  onPressIn,
  onPressOut,
  inverted = false,
}: PTTButtonProps): React.JSX.Element {
  const press = useSharedValue(0);
  const ring = useSharedValue(0);

  // Ring breath while active.
  useEffect(() => {
    if (active) {
      ring.value = 0;
      ring.value = withRepeat(
        withTiming(1, { duration: 1400, easing: Easing.out(Easing.quad) }),
        -1,
        false,
      );
    } else {
      cancelAnimation(ring);
      ring.value = withTiming(0, { duration: motion.fast });
    }
    return () => cancelAnimation(ring);
  }, [active, ring]);

  const handlePressIn = () => {
    if (disabled) return;
    haptics.tap();
    press.value = withSpring(1, motion.springSnappy);
    onPressIn();
  };

  const handlePressOut = () => {
    press.value = withSpring(0, motion.springSnappy);
    onPressOut();
  };

  const diskStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.06 * press.value }],
  }));

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + ring.value * 0.6 }],
    opacity: 0.55 * (1 - ring.value),
  }));

  const labelTone = disabled ? 'fgGhost' : active ? 'fg' : 'fgMuted';

  const disk: ViewStyle = {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: active ? accentRing : color.hairline,
    backgroundColor: active ? `${accent}15` : color.surface1,
  };

  return (
    <Pressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={`Micrófono ${label}`}
      accessibilityState={{ disabled, busy: active }}>
      <View
        style={[
          styles.wrap,
          { width: SIZE + 32, height: SIZE + 32 },
          inverted && styles.inverted,
        ]}>
        {active && (
          <Animated.View
            style={[
              styles.ring,
              {
                width: SIZE,
                height: SIZE,
                borderRadius: SIZE / 2,
                borderColor: accentRing,
              },
              ringStyle,
            ]}
          />
        )}
        <Animated.View style={[disk, diskStyle, disabled && styles.disabled]}>
          {active ? (
            <Waveform active color={accent} bars={5} height={26} />
          ) : (
            <View style={styles.labelStack}>
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: disabled ? color.fgGhost : color.fgMuted,
                  marginBottom: 6,
                }}
              />
              <Text variant="mono" tone={labelTone}>
                {label.toUpperCase()}
              </Text>
            </View>
          )}
        </Animated.View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  inverted: {
    transform: [{ rotate: '180deg' }],
  },
  ring: {
    position: 'absolute',
    borderWidth: 1.5,
  },
  labelStack: {
    alignItems: 'center',
  },
  disabled: {
    opacity: 0.35,
  },
});

PTTButton.SIZE = SIZE;

export const PTT_DEFAULT_ACCENT = color.fgMuted;
export const PTT_RADIUS = radius.pill;
