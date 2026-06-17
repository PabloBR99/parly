// SeamControl — the hands-free toggle, reimagined as a glass knob seated on
// the seam at centre-right.
//
// Why here, why neutral?
//   Hands-free is not a property of either speaker — it's a property of the
//   conversation. So it belongs on the seam (the encounter line), not in one
//   speaker's footer. It's neutral white for the same reason the seam is:
//   colour lives in the atmosphere, never in the chrome.
//
// The glyph is the seam itself — a horizon line with sound radiating up and
// down. Off: quiet glass. On: the ring warms with a soft radial bloom, the
// core breathes, and the echo arcs flare in the direction the translation
// just flowed (driven by `pulseDirection`, the same signal that runs the
// SeamShimmer). Paused (offline): muted and still.
//
// Implementation note: the glyph is three overlaid SVG layers, each wrapped
// in an Animated.View. We animate plain View opacity (rock-solid on Android)
// rather than animating SVG stroke props.

import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import LinearGradient from 'react-native-linear-gradient';
import Svg, { Circle, Defs, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { motion } from '../theme';
import { Text } from './Text';
import { haptics } from '../haptics';

export type SeamControlMode = 'off' | 'on' | 'paused';

interface SeamControlProps {
  readonly mode: SeamControlMode;
  /** 0 = idle, 1 = translation flowed down, -1 = flowed up. Flares the echo. */
  readonly pulseDirection: 0 | 1 | -1;
  readonly onToggle: () => void;
}

// ── Geometry ───────────────────────────────────────────────────────────────
const KNOB = 54;
const GLYPH = 28;          // viewBox; centre (14,14)
const GLOW = 128;          // radial bloom canvas behind the knob
const HALO = KNOB - 12;

// Arc caps, precomputed (see mockups/dusk-handsfree.html). Each is a portion
// of a circle centred on the glyph, opening toward the centre line — ripples
// radiating up and down from the horizon.
const CORE_PATH =
  'M 9.67 10.61 A 5.5 5.5 0 0 1 18.33 10.61 ' +   // inner up
  'M 18.33 17.39 A 5.5 5.5 0 0 1 9.67 17.39';      // inner down
const ECHO_UP = 'M 6.51 8.15 A 9.5 9.5 0 0 1 21.49 8.15';
const ECHO_DOWN = 'M 21.49 19.85 A 9.5 9.5 0 0 1 6.51 19.85';

const BREATH_MS = 1_900;

// ── Component ────────────────────────────────────────────────────────────────
export function SeamControl({ mode, pulseDirection, onToggle }: SeamControlProps): React.JSX.Element {
  const isOn = mode === 'on';
  const isPaused = mode === 'paused';

  const enter = useSharedValue(0);
  const press = useSharedValue(0);
  const pop = useSharedValue(1);
  const glow = useSharedValue(0);
  const breath = useSharedValue(0);
  const flareUp = useSharedValue(0);
  const flareDown = useSharedValue(0);

  // Mount entrance.
  useEffect(() => {
    enter.value = withTiming(1, { duration: 420, easing: Easing.out(Easing.cubic) });
  }, [enter]);

  // Glow + breath driven by mode.
  const wasOnRef = React.useRef(false);
  useEffect(() => {
    glow.value = withTiming(isOn ? 1 : 0, { duration: motion.normal });

    if (isOn) {
      // Subtle inhale when hands-free engages.
      if (!wasOnRef.current) {
        pop.value = withSequence(
          withTiming(1.07, { duration: 220, easing: Easing.out(Easing.ease) }),
          withSpring(1, motion.springSoft),
        );
      }
      breath.value = withRepeat(
        withSequence(
          withTiming(1, { duration: BREATH_MS, easing: Easing.inOut(Easing.sin) }),
          withTiming(0, { duration: BREATH_MS, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(breath);
      breath.value = withTiming(0, { duration: motion.fast });
    }
    wasOnRef.current = isOn;
    return () => cancelAnimation(breath);
  }, [isOn, glow, breath, pop]);

  // Echo arcs flare in the direction the translation just flowed.
  useEffect(() => {
    if (!isOn || pulseDirection === 0) return;
    const target = pulseDirection === -1 ? flareUp : flareDown;
    target.value = withSequence(
      withTiming(1, { duration: 160, easing: Easing.out(Easing.quad) }),
      withTiming(0, { duration: 460, easing: Easing.in(Easing.quad) }),
    );
  }, [pulseDirection, isOn, flareUp, flareDown]);

  const handlePress = () => {
    haptics.tap();
    onToggle();
  };

  // ── Animated styles ──────────────────────────────────────────────────────
  const wrapStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [
      { translateY: -KNOB / 2 },
      { scale: (0.86 + 0.14 * enter.value) * pop.value * (1 - 0.07 * press.value) },
    ],
  }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));
  const coreStyle = useAnimatedStyle(() => ({
    // Off: steady. On: breathe between 0.72 and 1.0.
    opacity: isOn ? 0.72 + 0.28 * breath.value : isPaused ? 0.5 : 0.82,
  }));
  const echoBase = isPaused ? 0.12 : 0.26;
  const echoUpStyle = useAnimatedStyle(() => ({ opacity: echoBase + (0.95 - echoBase) * flareUp.value }));
  const echoDownStyle = useAnimatedStyle(() => ({ opacity: echoBase + (0.95 - echoBase) * flareDown.value }));

  const ringColor = isOn
    ? 'rgba(255,255,255,0.32)'
    : isPaused
      ? 'rgba(255,255,255,0.10)'
      : 'rgba(255,255,255,0.13)';
  const strokeCol = isPaused ? 'rgba(255,255,255,0.55)' : '#FFFFFF';

  const caption = isOn ? 'listening' : isPaused ? 'offline' : 'hands-free';

  return (
    <Animated.View style={[styles.anchor, wrapStyle]} pointerEvents="box-none">
      <Pressable
        onPress={handlePress}
        onPressIn={() => { press.value = withSpring(1, motion.springSnappy); }}
        onPressOut={() => { press.value = withSpring(0, motion.springSnappy); }}
        hitSlop={14}
        accessibilityRole="button"
        accessibilityState={{ selected: isOn }}
        accessibilityLabel={`Hands-free, ${isOn ? 'on' : isPaused ? 'paused, offline' : 'off'}`}
        style={styles.press}>
        <View style={styles.knobBox}>
          {/* Active radial bloom behind the knob. */}
          <Animated.View style={[styles.glow, glowStyle]} pointerEvents="none">
            <Svg width={GLOW} height={GLOW}>
              <Defs>
                <RadialGradient id="hf-glow" cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
                  <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.18" />
                  <Stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.05" />
                  <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
                </RadialGradient>
              </Defs>
              <Circle cx={GLOW / 2} cy={GLOW / 2} r={GLOW / 2} fill="url(#hf-glow)" />
            </Svg>
          </Animated.View>

          {/* The glass knob. */}
          <View style={[styles.knob, { borderColor: ringColor }]}>
            <LinearGradient
              pointerEvents="none"
              colors={['rgba(255,255,255,0.06)', 'rgba(255,255,255,0.012)']}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            {/* Inner glossy halo. */}
            <View style={styles.halo} pointerEvents="none">
              <Svg width={HALO} height={HALO}>
                <Defs>
                  <RadialGradient id="hf-halo" cx="35%" cy="30%" rx="62%" ry="62%" fx="35%" fy="30%">
                    <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.09" />
                    <Stop offset="0.6" stopColor="#FFFFFF" stopOpacity="0.01" />
                    <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
                  </RadialGradient>
                </Defs>
                <Circle cx={HALO / 2} cy={HALO / 2} r={HALO / 2} fill="url(#hf-halo)" />
              </Svg>
            </View>

            {/* Glyph — three overlaid layers. */}
            <View style={styles.glyph} pointerEvents="none">
              <Animated.View style={[StyleSheet.absoluteFill, echoUpStyle]}>
                <Svg width={GLYPH} height={GLYPH} viewBox={`0 0 ${GLYPH} ${GLYPH}`}>
                  <Path d={ECHO_UP} stroke={strokeCol} strokeWidth={1.4} fill="none" strokeLinecap="round" />
                </Svg>
              </Animated.View>
              <Animated.View style={[StyleSheet.absoluteFill, echoDownStyle]}>
                <Svg width={GLYPH} height={GLYPH} viewBox={`0 0 ${GLYPH} ${GLYPH}`}>
                  <Path d={ECHO_DOWN} stroke={strokeCol} strokeWidth={1.4} fill="none" strokeLinecap="round" />
                </Svg>
              </Animated.View>
              <Animated.View style={[StyleSheet.absoluteFill, coreStyle]}>
                <Svg width={GLYPH} height={GLYPH} viewBox={`0 0 ${GLYPH} ${GLYPH}`}>
                  <Rect x={10.5} y={13.25} width={7} height={1.5} rx={0.75} fill={strokeCol} />
                  <Path d={CORE_PATH} stroke={strokeCol} strokeWidth={1.5} fill="none" strokeLinecap="round" />
                </Svg>
              </Animated.View>
            </View>

            {/* Live dot — present while listening. */}
            {isOn && <View style={styles.live} />}
          </View>
        </View>

        <Text variant="serifTiny" tone={isOn ? 'fgMuted' : 'fgFaint'} style={styles.caption}>
          {caption}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    right: 16,
    top: '50%',
  },
  press: {
    alignItems: 'center',
  },
  knobBox: {
    width: KNOB,
    height: KNOB,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    position: 'absolute',
    width: GLOW,
    height: GLOW,
    alignItems: 'center',
    justifyContent: 'center',
  },
  knob: {
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.012)',
  },
  halo: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: HALO,
    height: HALO,
  },
  glyph: {
    width: GLYPH,
    height: GLYPH,
  },
  live: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#FFFFFF',
    shadowColor: '#FFFFFF',
    shadowOpacity: 0.95,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    elevation: 3,
  },
  caption: {
    marginTop: 9,
  },
});
