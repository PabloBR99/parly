// DuskBackdrop — the warm/cool atmosphere that defines Dusk.
//
// Two suns meeting at the edge of the day. The phone is the table. Each
// half of the screen carries one sun's light: cool periwinkle at the top
// (the partner's edge), warm peach-terracotta at the bottom (the user's).
// They bleed toward the centre and meet at the seam — that's somebody
// else's component (Seam.tsx); this component just paints the atmosphere
// they sit in.
//
// We render a real vertical LinearGradient (5 stops, smooth interpolation)
// rather than stacking translucent half-overlays. The earlier "stacked
// bands" approach produced visible stair-step edges and the alpha math
// landed too close to bg on a near-black phone — read as "still flat
// black" rather than "evening sky". A native gradient gets us per-pixel
// interpolation and the colours read clearly against the phone surface.
//
// Stops: cool extreme at the top, fading toward bg through ~30% so the
// blooms above the seam still pop; bg at the centre so the seam (rendered
// separately) lands on a clean neutral line; warm extreme at the bottom,
// mirrored timing so the user's edge matches the partner's. Tuned dark
// enough to feel like atmosphere, saturated enough to clearly read as
// blue / orange, not gray.

import React from 'react';
import { StyleSheet } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';

const DUSK_STOPS = [
  '#181B33', // 0%   — periwinkle dark, partner's sky
  '#11111F', // 30%  — cool fading toward neutral
  '#0B0B11', // 50%  — bg (the seam sits here)
  '#13100E', // 70%  — warm fading in
  '#2E1810', // 100% — peach-terracotta dark, user's horizon
];
const DUSK_LOCATIONS = [0, 0.3, 0.5, 0.7, 1];

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
