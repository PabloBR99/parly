// FirstTouchTrace — the welcome line.
//
// First time in a session that someone presses their PTT, a slim line of
// their colour grows from their disc, across the dusk seam, to the other
// speaker's disc. The partner sees the light cross the phone before any
// translated word arrives — a wordless "I'm starting".
//
// One-shot per session. Driven by `trigger` (anything that changes — usually
// a counter or null/object swap from the parent). Side picks the colour and
// the direction (A = warm, grows upward; B = cool, grows downward).

import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

interface FirstTouchTraceProps {
  /** Side that just touched. `null` = idle, no render. Set to 'A'/'B' to fire. */
  readonly side: 'A' | 'B' | null;
  /** Hex / rgba for the warm (A) line. */
  readonly warmColor: string;
  /** Faint warm halo around the line. */
  readonly warmHalo: string;
  /** Hex / rgba for the cool (B) line. */
  readonly coolColor: string;
  /** Faint cool halo around the line. */
  readonly coolHalo: string;
}

export function FirstTouchTrace({
  side,
  warmColor,
  warmHalo,
  coolColor,
  coolHalo,
}: FirstTouchTraceProps): React.JSX.Element | null {
  // 0 → 1: line extends. 1 → 2: line fades.
  const progress = useSharedValue(0);

  useEffect(() => {
    if (side === null) {
      progress.value = 0;
      return;
    }
    progress.value = 0;
    progress.value = withSequence(
      withTiming(1, { duration: 700, easing: Easing.out(Easing.quad) }),
      withDelay(140, withTiming(2, { duration: 280, easing: Easing.in(Easing.quad) })),
    );
  }, [side, progress]);

  const animStyle = useAnimatedStyle(() => {
    const grow = Math.min(progress.value, 1);
    const fade = Math.max(0, progress.value - 1);
    return {
      transform: [{ scaleY: grow }],
      opacity: 1 - fade,
    };
  });

  if (side === null) return null;

  // Anchor on the speaker's edge so scaleY grows TOWARD the partner. Kept
  // out of the worklet — Reanimated 4's animated-style pipeline doesn't
  // process `transformOrigin`, so it has to ride on a static style sibling.
  // Two-token form ('center top' / 'center bottom') is the most portable
  // across RN / Fabric / old-arch on Android.
  const origin: 'center top' | 'center bottom' =
    side === 'A' ? 'center bottom' : 'center top';

  const lineColor = side === 'A' ? warmColor : coolColor;
  const haloColor = side === 'A' ? warmHalo : coolHalo;

  return (
    <View pointerEvents="none" style={styles.fill}>
      <Animated.View
        style={[
          styles.halo,
          { backgroundColor: haloColor, transformOrigin: origin },
          animStyle,
        ]}
      />
      <Animated.View
        style={[
          styles.line,
          { backgroundColor: lineColor, transformOrigin: origin },
          animStyle,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Spans 60% of the screen vertically, centred. That's roughly disc-to-disc.
  halo: {
    position: 'absolute',
    width: 6,
    height: '60%',
    borderRadius: 3,
  },
  line: {
    position: 'absolute',
    width: 1.5,
    height: '60%',
    borderRadius: 1,
  },
});
