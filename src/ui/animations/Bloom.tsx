// Bloom — the watercolour stain that breathes around each PTT.
//
// Three SVG radial-gradient stains drifting around the disc on coprime
// breath tempos. The cluster's silhouette keeps shifting like ink drying
// on paper. Warm palette (apricot / peach / terracotta) for the user's
// side, cool palette (periwinkle / seafoam / iris) for the partner's.
//
// Why SVG radial gradients with a 5-stop falloff (0.42 → 0.28 → 0.14 →
// 0.05 → 0) instead of CSS-style 3-stop tighter falloff: a 3-stop with
// a high centre alpha (0.72 was our previous attempt) renders as a hard
// circle with a halo — the "spotlight" failure mode. A 5-stop with a
// long alpha tail past 70% radius simulates the blur the HTML mockup
// gets from `filter: blur(30px)`. References (Loóna, Endel, Headspace)
// all use this pattern.
//
// Why cool stains carry a +0.06 alpha bonus on every stop: cool tones
// perceptually retreat against the cool-tinted top half of the dusk
// gradient (color theory: warm advances, cool retreats). Without the
// boost the cool bloom reads visibly fainter than the warm at equal
// nominal alpha. Loóna does the same thing.
//
// Why the breath drift is now ±1px and opacity drifts 0.92→1.00 (was
// ±3px and 0.55→0.85): ≥0.05 opacity drift reads as pulsing or loading
// state, not "alive". Premium atmospheric apps keep drift tiny.
// Tempos lengthened to 7.4 / 8.0 / 8.6s (was 5.4 / 6.0 / 6.6) so the
// motion feels meditative, not anxious.

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
// Cool side gets +~0.04 across the board (perceptual compensation —
// warm advances, cool retreats).
//
// Reduced ~25 % from the screen-blend-compensating values
// (warm 0.68 / 0.62 / 0.55, cool 0.72 / 0.66 / 0.58). On AMOLED phones
// the deep blacks made those numbers read as full-saturation paint; the
// mockup's softer feel comes mostly from `filter: blur(30px)` which RN
// can't reproduce, but lowering the peaks gets us closer to the
// translucent watercolour look without the blur.
const ALPHAS = {
  warm: { top: 0.51, mid: 0.46, deep: 0.41 },
  cool: { top: 0.54, mid: 0.49, deep: 0.43 },
} as const;

// Per-stain shape — slight ellipticity + static rotation so each stain
// reads as an ink drop pulled by capillary action rather than a
// mechanical perfect circle. Subtle (rx/ry within ±6 % of round, tilt
// within ±12°), combined with the asymmetric translate offsets and the
// breath drift to produce an irregular watercolour silhouette. The
// rotation is a string literal so it can be passed straight into
// Reanimated's transform array; the rx/ry strings flow through to the
// SVG <RadialGradient>.
const SHAPES = {
  top:  { rx: '54%', ry: '46%', rotate: '8deg'  },
  mid:  { rx: '46%', ry: '54%', rotate: '-6deg' },
  deep: { rx: '52%', ry: '48%', rotate: '12deg' },
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
  //
  // Drift is calibrated tiny — premium atmospheric apps keep amplitude
  // below the perceptual "is something animating?" threshold. The bloom
  // breathes; it doesn't pulse.

  const topStainStyle = useAnimatedStyle(() => {
    const t = breathTop.value;
    const scale = (0.97 + 0.05 * t) + 0.04 * activeBoost.value;
    const dx = TOP_OFFSET.x + (-0.5 + 1.0 * t);
    const dy = TOP_OFFSET.y + (-0.5 + 1.0 * t);
    // Opacity drift 0.92→1.00 (drift 0.08) — gentle. Active adds 0.04
    // so an active bloom is just-perceptibly fuller-bodied.
    const baseOpacity = 0.92 + 0.08 * t;
    const boosted = baseOpacity + 0.04 * activeBoost.value;
    const faded = boosted * (1 - disabledFade.value) + 0.05 * disabledFade.value;
    return {
      opacity: faded,
      transform: [
        { translateX: dx },
        { translateY: dy },
        { rotate: SHAPES.top.rotate },
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
    const faded = boosted * (1 - disabledFade.value) + 0.05 * disabledFade.value;
    return {
      opacity: faded,
      transform: [
        { translateX: dx },
        { translateY: dy },
        { rotate: SHAPES.mid.rotate },
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
    const faded = boosted * (1 - disabledFade.value) + 0.05 * disabledFade.value;
    return {
      opacity: faded,
      transform: [
        { translateX: dx },
        { translateY: dy },
        { rotate: SHAPES.deep.rotate },
        { scale },
      ],
    };
  });

  const palette = side === 'A' ? WARM : COOL;
  const alphas  = side === 'A' ? ALPHAS.warm : ALPHAS.cool;

  return (
    <View pointerEvents="none" style={[styles.container, { width: size, height: size }]}>
      <Animated.View style={[styles.stain, topStainStyle]}>
        <StainCircle size={size} fill={palette[0]} peak={alphas.top}  rx={SHAPES.top.rx}  ry={SHAPES.top.ry}  idSuffix={`${side}-top`} />
      </Animated.View>
      <Animated.View style={[styles.stain, midStainStyle]}>
        <StainCircle size={size} fill={palette[1]} peak={alphas.mid}  rx={SHAPES.mid.rx}  ry={SHAPES.mid.ry}  idSuffix={`${side}-mid`} />
      </Animated.View>
      <Animated.View style={[styles.stain, deepStainStyle]}>
        <StainCircle size={size} fill={palette[2]} peak={alphas.deep} rx={SHAPES.deep.rx} ry={SHAPES.deep.ry} idSuffix={`${side}-deep`} />
      </Animated.View>
    </View>
  );
}

interface StainCircleProps {
  readonly size: number;
  readonly fill: string;
  /** Peak alpha at the centre. Tail stops are computed as fixed ratios. */
  readonly peak: number;
  /** Horizontal radius of the radial gradient as a percentage string. */
  readonly rx: string;
  /** Vertical radius of the radial gradient as a percentage string. */
  readonly ry: string;
  readonly idSuffix: string;
}

function StainCircle({ size, fill, peak, rx, ry, idSuffix }: StainCircleProps): React.JSX.Element {
  // 5-stop falloff. Stops shifted further OUTWARD and alpha factors made
  // softer so the gradient diffuses across more of its radius — the
  // "blur substitute" for the mockup's `filter: blur(30px)`. The new
  // curve has visible alpha out to 80% of the radius, so on a 480px
  // bloom the warm wash carries to within ~50px of the bloom edge
  // instead of fading inside the inner third.
  //
  // Old curve (kept for reference): stops 0/.18/.42/.72/1, factors
  // 1/.66/.32/.11/0 — very tight, plus a hard step from .72 to 1.
  // New curve: stops 0/.22/.50/.80/1, factors 1/.78/.50/.22/0.
  const a0 = peak;
  const a1 = peak * 0.78;
  const a2 = peak * 0.50;
  const a3 = peak * 0.22;
  const id = `bloom-${idSuffix}`;
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" rx={rx} ry={ry} fx="50%" fy="50%">
          <Stop offset="0"    stopColor={fill} stopOpacity={a0.toString()} />
          <Stop offset="0.22" stopColor={fill} stopOpacity={a1.toString()} />
          <Stop offset="0.50" stopColor={fill} stopOpacity={a2.toString()} />
          <Stop offset="0.80" stopColor={fill} stopOpacity={a3.toString()} />
          <Stop offset="1"    stopColor={fill} stopOpacity="0" />
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
