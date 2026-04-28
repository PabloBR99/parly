// DuskBackdrop — the warm/cool atmosphere that defines Dusk.
//
// Two suns meeting at the edge of the day. The phone is the table. Each
// half of the screen carries one sun's light: cool periwinkle at the top
// (the partner's edge), warm peach at the bottom (the user's). They bleed
// toward the centre and meet at the seam — that's somebody else's component
// (Seam.tsx); this component just paints the atmosphere they sit in.
//
// Why four bands per side instead of one flat overlay: a single 50%-tall
// translucent View paints a hard horizon and reads as a coloured bar, not
// a sky. Stacking a wide base wash + two progressively-shorter "boost"
// washes anchored at the screen edge gives a stair-step gradient that's
// most saturated in the corners and fades toward the middle — close
// enough to the mockup's linear-gradient(180deg, cool→warm) on a phone
// without the project carrying a gradient or SVG dependency.
//
// pointerEvents="none" so this never intercepts a press; alignSelf-fill
// via StyleSheet.absoluteFill so it stretches whatever parent it lands in.

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { color } from '../theme';

export function DuskBackdrop(): React.JSX.Element {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {/* Cool half — top */}
      <View style={styles.coolBase} />
      <View style={styles.coolMid} />
      <View style={styles.coolEdge} />
      {/* Warm half — bottom */}
      <View style={styles.warmBase} />
      <View style={styles.warmMid} />
      <View style={styles.warmEdge} />
    </View>
  );
}

const styles = StyleSheet.create({
  // Top half — cool atmosphere. Each band stacks: base covers the full top
  // half at moderate alpha, mid concentrates colour in the upper third, edge
  // intensifies the very top.
  coolBase: {
    position: 'absolute',
    left: 0, right: 0, top: 0,
    height: '50%',
    backgroundColor: color.bgCoolEdge,
  },
  coolMid: {
    position: 'absolute',
    left: 0, right: 0, top: 0,
    height: '32%',
    backgroundColor: color.bgCoolBoost,
  },
  coolEdge: {
    position: 'absolute',
    left: 0, right: 0, top: 0,
    height: '14%',
    backgroundColor: color.bgCoolBoost,
  },
  // Bottom half — warm atmosphere. Mirror of the cool side.
  warmBase: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: '50%',
    backgroundColor: color.bgWarmEdge,
  },
  warmMid: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: '32%',
    backgroundColor: color.bgWarmBoost,
  },
  warmEdge: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: '14%',
    backgroundColor: color.bgWarmBoost,
  },
});
