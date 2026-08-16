// Bloom — the watercolour stain that breathes around each PTT.
//
// Three SVG radial-gradient stains drifting around the disc on coprime
// breath tempos. The cluster's silhouette keeps shifting like ink drying
// on paper. Warm palette (apricot / peach / terracotta) for the user's
// side, cool palette (periwinkle / seafoam / iris) for the partner's.
//
// The 10-stop gaussian-like falloff exists because RN cannot blur. The mockup's
// butter-soft halo comes from `filter: blur(30px)`, a true gaussian whose alpha
// asymptotes to zero instead of crossing it at a defined radius, so this
// approximates it by spending 78%→100% of the radius below 7% peak. Earlier
// 6-stop curves left ~3% combined alpha in the outer band against a near-black
// background — just enough to read as a circular edge. This curve is under 1%
// past 90% radius, so the bloom dissolves rather than ends.
//
// Cool stains carry +0.06 alpha on every stop: warm advances and cool retreats,
// so against the cool-tinted top half of the dusk gradient an equal nominal
// alpha reads visibly fainter.
//
// Breath drift is ±1px with opacity 0.92→1.00, and tempos are 7.4 / 8.0 / 8.6s.
// Anything past ~0.05 opacity drift reads as pulsing or loading rather than
// alive, and faster tempos feel anxious instead of meditative.

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
  /** Multiplier [0-1] applied to final opacity. Used in HF mode to keep the
   *  bloom recessive (0.30 for hf-idle). Default 1.0. */
  readonly intensity?: number;
}

// Stain offsets — kept small so the three blobs cluster *tightly* around
// the disc rather than spreading into a wider blobby cloud. The mockup's
// `filter: blur(30px)` dissolves three distinct gradients into one round
// luminous halo; in RN we don't have blur, so we approximate the same
// look by overlapping the stains close to the centre. Asymmetry is still
// preserved (top-left up, mid-right down, deep-centre below) — without
// it the bloom reads as a single mechanical circle, not a watercolour.
const TOP_OFFSET  = { x: -22, y: -28 };
const MID_OFFSET  = { x:  26, y:  18 };
const DEEP_OFFSET = { x:  -4, y:  32 };

// Coprime-ish breath periods so the three stains never lock phase.
// Slowed from the previous pass — the bloom should feel meditative.
const TOP_PERIOD  = 7400;
const MID_PERIOD  = 8000;
const DEEP_PERIOD = 8600;

// Palettes — order is (top stain, mid stain, deep stain).
const WARM = ['#FFB37A', '#FF8E76', '#E26F5C'] as const;  // apricot / peach / terracotta
const COOL = ['#A8B2FF', '#7FD8C9', '#9C8AE6'] as const;  // periwinkle / seafoam / iris

// Per-stain peak alphas. Top stain is brightest, deep is most saturated
// but lowest alpha so its hue tints the cluster without dominating.
// Cool side gets +0.04 across the board (perceptual compensation —
// warm advances, cool retreats).
//
// Alphas raised from the previous pass (0.44/0.39/0.35 warm) to
// (0.52/0.46/0.40). Combined compositing at centre: 1-(0.48×0.54×0.60)
// ≈ 0.84 opacity — luminous but not spotlight-hard, because the 6-stop
// gaussian curve feathers quickly past the inner radius.
//
// The organic, irregular silhouette comes from the three asymmetric
// translate offsets (TOP/MID/DEEP_OFFSET) and the coprime breath
// periods — not from ellipticity or rotation on the SVG container.
// Rotating a rectangular SVG reveals its corners, producing a polygonal
// stepped artefact. rx/ry asymmetry on react-native-svg RadialGradient
// also renders with visible banding. Stains stay circular; the cluster
// reads as a watercolour wash through overlap and drift alone.
const ALPHAS = {
  warm: { top: 0.52, mid: 0.46, deep: 0.40 },
  cool: { top: 0.56, mid: 0.50, deep: 0.44 },
} as const;

export function Bloom({ side, size, active, disabled, intensity = 1 }: BloomProps): React.JSX.Element {
  const breathTop  = useSharedValue(0);
  const breathMid  = useSharedValue(0);
  const breathDeep = useSharedValue(0);
  const activeBoost  = useSharedValue(0);
  const disabledFade = useSharedValue(0);
  const intensityVal = useSharedValue(intensity);

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

  useEffect(() => {
    intensityVal.value = withTiming(intensity, { duration: motion.normal });
  }, [intensity, intensityVal]);

  // Per-stain animated styles. Reanimated 4's Babel plugin does NOT
  // auto-promote module-scope arrow helpers to worklets, so the math is
  // inlined here in each style. Calling a non-worklet from inside a
  // useAnimatedStyle callback crashes the screen on first frame on Android.
  //
  // Drift is calibrated tiny — premium atmospheric apps keep amplitude
  // below the perceptual "is something animating?" threshold. The bloom
  // breathes; it doesn't pulse.

  const topStainStyle = useAnimatedStyle(() => {
    const t = breathTop.value;
    const scale = (0.97 + 0.05 * t) + 0.04 * activeBoost.value;
    const dx = TOP_OFFSET.x + (-0.5 + 1.0 * t);
    const dy = TOP_OFFSET.y + (-0.5 + 1.0 * t);
    const baseOpacity = 0.92 + 0.08 * t;
    const boosted = baseOpacity + 0.04 * activeBoost.value;
    const faded = (boosted * (1 - disabledFade.value) + 0.05 * disabledFade.value) * intensityVal.value;
    return {
      opacity: faded,
      transform: [
        { translateX: dx },
        { translateY: dy },
        { scale },
      ],
    };
  });

  const midStainStyle = useAnimatedStyle(() => {
    const t = breathMid.value;
    const scale = (0.97 + 0.05 * t) + 0.04 * activeBoost.value;
    const dx = MID_OFFSET.x + (0.5 - 1.0 * t);
    const dy = MID_OFFSET.y + (0.5 - 1.0 * t);
    const baseOpacity = 0.92 + 0.08 * t;
    const boosted = baseOpacity + 0.04 * activeBoost.value;
    const faded = (boosted * (1 - disabledFade.value) + 0.05 * disabledFade.value) * intensityVal.value;
    return {
      opacity: faded,
      transform: [
        { translateX: dx },
        { translateY: dy },
        { scale },
      ],
    };
  });

  const deepStainStyle = useAnimatedStyle(() => {
    const t = breathDeep.value;
    const scale = (0.97 + 0.05 * t) + 0.04 * activeBoost.value;
    const dx = DEEP_OFFSET.x + (-0.5 + 1.0 * t);
    const dy = DEEP_OFFSET.y + (0.5 - 1.0 * t);
    const baseOpacity = 0.92 + 0.08 * t;
    const boosted = baseOpacity + 0.04 * activeBoost.value;
    const faded = (boosted * (1 - disabledFade.value) + 0.05 * disabledFade.value) * intensityVal.value;
    return {
      opacity: faded,
      transform: [
        { translateX: dx },
        { translateY: dy },
        { scale },
      ],
    };
  });

  const palette = side === 'A' ? WARM : COOL;
  const alphas  = side === 'A' ? ALPHAS.warm : ALPHAS.cool;

  return (
    <View pointerEvents="none" style={[styles.container, { width: size, height: size }]}>
      <Animated.View style={[styles.stain, topStainStyle]}>
        <StainCircle size={size} fill={palette[0]} peak={alphas.top}  idSuffix={`${side}-top`} />
      </Animated.View>
      <Animated.View style={[styles.stain, midStainStyle]}>
        <StainCircle size={size} fill={palette[1]} peak={alphas.mid}  idSuffix={`${side}-mid`} />
      </Animated.View>
      <Animated.View style={[styles.stain, deepStainStyle]}>
        <StainCircle size={size} fill={palette[2]} peak={alphas.deep} idSuffix={`${side}-deep`} />
      </Animated.View>
    </View>
  );
}

interface StainCircleProps {
  readonly size: number;
  readonly fill: string;
  /** Peak alpha at the centre. Tail stops are computed as fixed ratios. */
  readonly peak: number;
  readonly idSuffix: string;
}

function StainCircle({ size, fill, peak, idSuffix }: StainCircleProps): React.JSX.Element {
  // 10-stop gaussian-like falloff (σ ≈ 0.32 in normalised radius). The
  // outer 30% of the radius spends almost the entire alpha budget on
  // dissolving — by 88% radius the stain is at 2% peak, by 95% at
  // 0.5%, asymptoting to zero at the boundary. With three stains
  // overlapping at peak ~0.50, combined alpha at 88% radius is
  // ~3 × (0.02 × 0.50) ≈ 0.03 — invisible against the dusk
  // background, eliminating the visible circular halo earlier passes
  // produced.
  const a0 = peak;
  const a1 = peak * 0.95;
  const a2 = peak * 0.78;
  const a3 = peak * 0.55;
  const a4 = peak * 0.32;
  const a5 = peak * 0.16;
  const a6 = peak * 0.07;
  const a7 = peak * 0.02;
  const a8 = peak * 0.005;
  const id = `bloom-${idSuffix}`;
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
          <Stop offset="0"    stopColor={fill} stopOpacity={a0.toString()} />
          <Stop offset="0.08" stopColor={fill} stopOpacity={a1.toString()} />
          <Stop offset="0.20" stopColor={fill} stopOpacity={a2.toString()} />
          <Stop offset="0.35" stopColor={fill} stopOpacity={a3.toString()} />
          <Stop offset="0.50" stopColor={fill} stopOpacity={a4.toString()} />
          <Stop offset="0.65" stopColor={fill} stopOpacity={a5.toString()} />
          <Stop offset="0.78" stopColor={fill} stopOpacity={a6.toString()} />
          <Stop offset="0.88" stopColor={fill} stopOpacity={a7.toString()} />
          <Stop offset="0.95" stopColor={fill} stopOpacity={a8.toString()} />
          <Stop offset="1"    stopColor={fill} stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect width={size} height={size} fill={`url(#${id})`} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center' },
  stain: {
    position: 'absolute',
    // Pinned 0,0 — actual placement comes from the animated transform.
    top: 0,
    left: 0,
  },
});
