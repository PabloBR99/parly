// DuskBackdrop — the warm/cool atmosphere that defines Dusk, painted
// as one continuous vertical gradient.
//
// Two suns meeting at the edge of the day. Cool periwinkle at the top
// (the partner's edge) fades into a near-black band at 50%, then fades
// back out into warm peach-terracotta at the bottom (the user's edge).
// The cool and warm sides never touch — a clear dark zone keeps them
// apart. The "horizon" is the natural near-black middle, not a separate
// component. There is no horizontal hairline overlay, no warm/cool
// haze band; those read as engineered horizontal elements crossing the
// painterly atmosphere. The gradient does it all.

import React from 'react';
import { StyleSheet } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';

// Nine stops. Two extra intermediate stops (at 10% and 90%) hold the
// edge colours longer before transitioning to the dark horizon — like
// an actual sky where saturated colour lingers near the horizon before
// night takes over. The edge stops themselves are pushed to richer,
// more saturated hues: deeper indigo-periwinkle at the top, richer
// terracotta at the bottom. The dark centre band is untouched.
const DUSK_STOPS = [
  '#1C2244', //   0% — rich indigo-periwinkle, partner's sky
  '#191E3D', //  10% — holding the cool hue before it recedes
  '#0D0F1E', //  25% — cool almost-black, transitioning to horizon
  '#060609', //  42% — deep, almost black
  '#030305', //  50% — true near-black, the horizon
  '#060406', //  58% — deep, almost black (warm-tinted)
  '#1A130D', //  75% — warm rising from dark
  '#2E1509', //  90% — holding the warm hue before the edge
  '#3C1C0C', // 100% — rich peach-terracotta, user's horizon
];
const DUSK_LOCATIONS = [0, 0.10, 0.25, 0.42, 0.5, 0.58, 0.75, 0.90, 1];

export function DuskBackdrop(): React.JSX.Element {
  return (
    <LinearGradient
      pointerEvents="none"
      colors={DUSK_STOPS}
      locations={DUSK_LOCATIONS}
      start={{ x: 0.5, y: 0 }}
      end={{ x: 0.5, y: 1 }}
      style={StyleSheet.absoluteFill}
    />
  );
}
