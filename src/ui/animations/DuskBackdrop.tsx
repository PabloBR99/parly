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

// Seven stops. The horizon is now the natural near-black zone in the
// middle of the gradient itself (no Seam component, no horizontal band,
// no hairline overlay). Cool periwinkle fades into a true near-black
// at 50%, then fades back out into warm peach. The cool and warm sides
// never touch — a clear dark band keeps them apart, like dusk where the
// last of the warm horizon dies into night before the cool of the
// upper sky takes over.
const DUSK_STOPS = [
  '#1B1F38', //   0% — periwinkle dark, partner's sky
  '#131525', //  22% — cool fading toward dark
  '#060609', //  42% — deep, almost black
  '#030305', //  50% — true near-black, the horizon
  '#060406', //  58% — deep, almost black (warm-tinted)
  '#1A130D', //  78% — warm rising from dark
  '#341B10', // 100% — peach-terracotta dark, user's horizon
];
const DUSK_LOCATIONS = [0, 0.22, 0.42, 0.5, 0.58, 0.78, 1];

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
