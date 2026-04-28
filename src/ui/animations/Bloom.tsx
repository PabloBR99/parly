// Bloom — the watercolour stain that breathes around each PTT.
//
// Three radial gradient blobs (top / mid / deep) drifting around the disc,
// each on its own coprime breath tempo so the cluster's silhouette keeps
// shifting like ink drying on paper. Warm palette (apricot / peach /
// terracotta) for the user's side, cool palette (periwinkle / seafoam /
// iris) for the partner's.
//
// Why SVG radial gradients instead of translucent <View> circles: a flat
// rgba View renders a HARD-edged circle. Stacking three of them produces
// concentric ring artefacts and visible disc edges — what the user saw
// in the previous build, "discos de color apilados" instead of pigment.
// SVG <RadialGradient> interpolates per-pixel from solid centre to fully
// transparent edge, no border. With three offset stains drifting on
// independent tempos, the result reads as paint on wet paper.
//
// The stain layout (offsets, breath tempos, opacity ranges) lives here in
// module scope; only `side`/`size`/`active`/`disabled` cross the prop
// boundary, so a parent can drop a Bloom anywhere without re-deriving
// palette and animation choreography.

import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { motion } from '../theme';

type Side = 'A' | 'B';

interface BloomProps {
  /** 'A' = warm (user's side), 'B' = cool (partner's). */
  readonly side: Side;
  /** Outer footprint of the bloom in points. The three stains span this. */
  readonly size: number;
  /** Active brightens stains; inactive lets them sit at base levels. */
  readonly active: boolean;
  /** Disabled fades stains to a near-invisible whisper. */
  readonly disabled: boolean;
}

// Stain offsets — asymmetric so the three blobs cluster around the disc but
// never share a centre. The cluster's overlapping edges form a watercolour
// shape, not concentric rings.
const TOP_OFFSET  = { x: -38, y: -46 };
const MID_OFFSET  = { x:  42, y:  28 };
const DEEP_OFFSET = { x:  -6, y:  52 };

// Coprime-ish breath periods so the three stains never lock phase.
const TOP_PERIOD  = 5400;
const MID_PERIOD  = 6000;
const DEEP_PERIOD = 6600;

// Palettes — order is (top stain, mid stain, deep stain).
const WARM = ['#FFB37A', '#FF8E76', '#E26F5C'] as const;  // apricot / peach / terracotta
const COOL = ['#A8B2FF', '#7FD8C9', '#9C8AE6'] as const;  // periwinkle / seafoam / iris

// Each stain's radial gradient stops. Solid-ish at centre, mid-fade at the
// halfway radius, fully transparent at the edge. Tuned to compensate for
// the lack of `mix-blend-mode: screen` and `filter: blur(30px)` that the
// HTML mockup uses — alpha-blend over near-black bg lifts less than screen
// blend, so the centre alpha is pushed harder than the mockup's 0.85.
const STAIN_STOPS = {
  centre: '0.72',
  mid:    '0.18',
  edge:   '0',
} as const;

export function Bloom({ side, size, active, disabled }: BloomProps): React.JSX.Element {
  const breathTop  = useSharedValue(0);
  const breathMid  = useSharedValue(0);
  const breathDeep = useSharedValue(0);
  const activeBoost  = useSharedValue(0);
  const disabledFade = useSharedValue(0);

  useEffect(() => {
    breathTop.value = withRepeat(
      withTiming(1, { duration: TOP_PERIOD,  easing: Easing.inOut(Easing.sin) }),
      -1, true,
    );
    breathMid.value = withRepeat(
      withTiming(1, { duration: MID_PERIOD,  easing: Easing.inOut(Easing.sin) }),
      -1, true,
    );
    breathDeep.value = withRepeat(
      withTiming(1, { duration: DEEP_PERIOD, easing: Easing.inOut(Easing.sin) }),
      -1, true,
    );
    return () => {
      cancelAnimation(breathTop);
      cancelAnimation(breathMid);
      cancelAnimation(breathDeep);
    };
  }, [breathTop, breathMid, breathDeep]);

  useEffect(() => {
    activeBoost.value = withTiming(active ? 1 : 0, { duration: motion.normal });
  }, [active, activeBoost]);

  useEffect(() => {
    disabledFade.value = withTiming(disabled ? 1 : 0, { duration: motion.normal });
  }, [disabled, disabledFade]);

  // Per-stain animated styles. Reanimated 4's Babel plugin does NOT
  // auto-promote module-scope arrow helpers to worklets, so the math is
  // inlined here in each style. Calling a non-worklet from inside a
  // useAnimatedStyle callback crashes the screen on first frame on Android.

  const topStainStyle = useAnimatedStyle(() => {
    const t = breathTop.value;
    const scale = (0.92 + 0.14 * t) + 0.06 * activeBoost.value;
    const dx = TOP_OFFSET.x + (-3 + 6 * t);
    const dy = TOP_OFFSET.y + (-3 + 6 * t);
    const baseOpacity = 0.55 + 0.30 * t;
    const boosted = baseOpacity + 0.20 * activeBoost.value;
    const faded = boosted * (1 - disabledFade.value) + 0.05 * disabledFade.value;
    return {
      opacity: faded,
      transform: [{ translateX: dx }, { translateY: dy }, { scale }],
    };
  });

  const midStainStyle = useAnimatedStyle(() => {
    const t = breathMid.value;
    const scale = (0.94 + 0.10 * t) + 0.06 * activeBoost.value;
    const dx = MID_OFFSET.x + (3 - 6 * t);
    const dy = MID_OFFSET.y + (3 - 6 * t);
    const baseOpacity = 0.62 + 0.30 * t;
    const boosted = baseOpacity + 0.20 * activeBoost.value;
    const faded = boosted * (1 - disabledFade.value) + 0.05 * disabledFade.value;
    return {
      opacity: faded,
      transform: [{ translateX: dx }, { translateY: dy }, { scale }],
    };
  });

  const deepStainStyle = useAnimatedStyle(() => {
    const t = breathDeep.value;
    const scale = (0.95 + 0.10 * t) + 0.06 * activeBoost.value;
    const dx = DEEP_OFFSET.x + (-3 + 6 * t);
    const dy = DEEP_OFFSET.y + (3 - 6 * t);
    const baseOpacity = 0.68 + 0.30 * t;
    const boosted = baseOpacity + 0.20 * activeBoost.value;
    const faded = boosted * (1 - disabledFade.value) + 0.05 * disabledFade.value;
    return {
      opacity: faded,
      transform: [{ translateX: dx }, { translateY: dy }, { scale }],
    };
  });

  const palette = side === 'A' ? WARM : COOL;

  return (
    <View pointerEvents="none" style={[styles.container, { width: size, height: size }]}>
      <Animated.View style={[styles.stain, topStainStyle]}>
        <StainCircle size={size} fill={palette[0]} idSuffix={`${side}-top`} />
      </Animated.View>
      <Animated.View style={[styles.stain, midStainStyle]}>
        <StainCircle size={size} fill={palette[1]} idSuffix={`${side}-mid`} />
      </Animated.View>
      <Animated.View style={[styles.stain, deepStainStyle]}>
        <StainCircle size={size} fill={palette[2]} idSuffix={`${side}-deep`} />
      </Animated.View>
    </View>
  );
}

interface StainCircleProps {
  readonly size: number;
  readonly fill: string;
  readonly idSuffix: string;
}

function StainCircle({ size, fill, idSuffix }: StainCircleProps): React.JSX.Element {
  // Each <Svg> is its own scope, so `id` collisions across Svg roots are
  // harmless — but we suffix anyway to keep things obvious in dev tools.
  const id = `bloom-${idSuffix}`;
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" rx="50%" ry="50%" fx="50%" fy="50%">
          <Stop offset="0"    stopColor={fill} stopOpacity={STAIN_STOPS.centre} />
          <Stop offset="0.45" stopColor={fill} stopOpacity={STAIN_STOPS.mid} />
          <Stop offset="1"    stopColor={fill} stopOpacity={STAIN_STOPS.edge} />
        </RadialGradient>
      </Defs>
      <Rect width={size} height={size} fill={`url(#${id})`} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  stain: {
    position: 'absolute',
    // Pinned 0,0 — actual placement comes from the animated transform.
    top: 0,
    left: 0,
  },
});
