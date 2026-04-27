// PTTButton — the conversation's only interactive object.
//
// Object metaphor: a polished disc set into the surface of the phone, with
// concentric translucent halos that whisper outward even at rest. The disc
// is a thumb-rest. When held, it scales gently and its halos brighten; when
// active, an outer ring breathes outward and a delicate waveform breathes
// inside.
//
// We deliberately keep ALWAYS-on faint halos so the button feels like an
// object, not a hit-target painted onto a flat background. Depth on dark
// has to come from translucent layering — there is no shadow trick available
// when the surface is true black.

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
  readonly label: string;        // language code, e.g. "ES"
  readonly accent: string;       // accent color (Person A or B)
  readonly accentRing: string;   // accent ring tint
  readonly accentGlow: string;   // outer halo tint
  readonly accentWhisper: string;// far-field halo tint
  readonly active: boolean;      // currently recording
  readonly disabled: boolean;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
  /** Inverted = render upside-down (top half of the conversation surface). */
  readonly inverted?: boolean;
}

const SIZE = 96;
const HALO_OUTER = SIZE + 96;   // far-field whisper
const HALO_MID = SIZE + 48;     // soft glow
const HALO_INNER = SIZE + 18;   // ring kiss

export function PTTButton({
  label,
  accent,
  accentRing,
  accentGlow,
  accentWhisper,
  active,
  disabled,
  onPressIn,
  onPressOut,
  inverted = false,
}: PTTButtonProps): React.JSX.Element {
  const press = useSharedValue(0);
  const ring = useSharedValue(0);
  const idleHalo = useSharedValue(0);

  // Active outer-ring breath.
  useEffect(() => {
    if (active) {
      ring.value = 0;
      ring.value = withRepeat(
        withTiming(1, { duration: 1600, easing: Easing.out(Easing.quad) }),
        -1,
        false,
      );
    } else {
      cancelAnimation(ring);
      ring.value = withTiming(0, { duration: motion.fast });
    }
    return () => cancelAnimation(ring);
  }, [active, ring]);

  // Idle whisper — a slow far-field exhale, even at rest. Disabled when
  // the button is disabled (no-key state) so it doesn't beckon attention.
  useEffect(() => {
    if (disabled) {
      cancelAnimation(idleHalo);
      idleHalo.value = withTiming(0, { duration: motion.normal });
      return;
    }
    idleHalo.value = withRepeat(
      withTiming(1, { duration: 3200, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    return () => cancelAnimation(idleHalo);
  }, [disabled, idleHalo]);

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

  // Disc grows on press; barely, like a real button being pressed in.
  const diskStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.05 * press.value }],
  }));

  // Outer breathing ring on active.
  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + ring.value * 0.55 }],
    opacity: 0.6 * (1 - ring.value),
  }));

  // Inner halo (closest to disc): brightens on press AND on active.
  const innerHaloStyle = useAnimatedStyle(() => {
    const base = active ? 0.85 : 0.25 + 0.30 * idleHalo.value + 0.45 * press.value;
    return { opacity: Math.min(base, 1) };
  });

  // Mid halo: gentler, breathes on idle.
  const midHaloStyle = useAnimatedStyle(() => {
    const base = active ? 0.55 : 0.18 + 0.22 * idleHalo.value + 0.30 * press.value;
    return { opacity: Math.min(base, 1) };
  });

  // Outer whisper: always a faint presence so the disc has weight.
  const outerHaloStyle = useAnimatedStyle(() => {
    const base = active ? 0.40 : 0.55 + 0.45 * idleHalo.value;
    return { opacity: Math.min(base, 1) };
  });

  const labelTone = disabled ? 'fgGhost' : active ? 'fg' : 'fgMuted';

  const disk: ViewStyle = {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: active ? accentRing : color.hairlineStrong,
    backgroundColor: active ? `${accent}1A` : color.surface1,
  };

  const wrapW = HALO_OUTER;
  const wrapH = HALO_OUTER;

  return (
    <Pressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={`Microphone ${label}`}
      accessibilityState={{ disabled, busy: active }}>
      <View
        style={[
          styles.wrap,
          { width: wrapW, height: wrapH },
          inverted && styles.inverted,
        ]}>
        {/* Outermost whisper — far-field glow. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.halo,
            {
              width: HALO_OUTER,
              height: HALO_OUTER,
              borderRadius: HALO_OUTER / 2,
              backgroundColor: accentWhisper,
            },
            outerHaloStyle,
            disabled && styles.disabledHalo,
          ]}
        />
        {/* Mid halo — soft glow. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.halo,
            {
              width: HALO_MID,
              height: HALO_MID,
              borderRadius: HALO_MID / 2,
              backgroundColor: accentGlow,
            },
            midHaloStyle,
            disabled && styles.disabledHalo,
          ]}
        />
        {/* Inner halo — the kiss right at the disc edge. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.halo,
            {
              width: HALO_INNER,
              height: HALO_INNER,
              borderRadius: HALO_INNER / 2,
              backgroundColor: accentGlow,
            },
            innerHaloStyle,
            disabled && styles.disabledHalo,
          ]}
        />
        {/* Active outward-breathing ring. */}
        {active && (
          <Animated.View
            pointerEvents="none"
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
        {/* The disc itself. */}
        <Animated.View style={[disk, diskStyle, disabled && styles.disabled]}>
          {active ? (
            <Waveform active color={accent} bars={5} height={30} />
          ) : (
            <View style={styles.labelStack}>
              {/* Subtle horizontal mic-affordance: a clean tick line above
                  the language code. Replaces the old puck-dot. */}
              <View
                style={{
                  width: 14,
                  height: 1.5,
                  borderRadius: 1,
                  backgroundColor: disabled ? color.fgGhost : color.fgFaint,
                  marginBottom: 8,
                }}
              />
              <Text variant="mono" tone={labelTone} style={styles.codeLabel}>
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
  halo: {
    position: 'absolute',
  },
  ring: {
    position: 'absolute',
    borderWidth: 1.5,
  },
  labelStack: {
    alignItems: 'center',
  },
  codeLabel: {
    fontSize: 12,
    letterSpacing: 1.6,
  },
  disabled: {
    opacity: 0.32,
  },
  disabledHalo: {
    opacity: 0,
  },
});

PTTButton.SIZE = SIZE;
PTTButton.FOOTPRINT = HALO_OUTER;

export const PTT_DEFAULT_ACCENT = color.fgMuted;
export const PTT_RADIUS = radius.pill;
