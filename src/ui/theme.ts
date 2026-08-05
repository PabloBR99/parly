// Parly design tokens — "Dusk" theme.
//
// Aesthetic: two suns meeting at the edge of the day. The phone is the table.
// Each speaker is a sun at one edge — warm bloom (apricot / peach / terracotta)
// at the user's edge, cool bloom (periwinkle / seafoam / iris) at the partner's.
// Their lights bleed toward the centre and meet in a soft seam — not a
// divider, an encounter. Translation text stays pure white; colour lives in
// the atmosphere, never in the words.
//
// Typography is bilingual in spirit: pure sans for translated content (the
// reading), serif italic for the chrome (codes, labels, microcopy) — softens
// the technical edge of a translator. Mono is gone.

import { Platform } from 'react-native';

// ── Color ────────────────────────────────────────────────────────────────────

export const color = {
  // Surfaces — base is no longer pure black. A hair toward dusk so the warm
  // and cool overlays read as warmth, not a colour cast. The full
  // periwinkle→bg→peach sky is painted by `DuskBackdrop` via a real
  // LinearGradient, so we don't carry any wash-tint tokens here anymore.
  bg:        '#0B0B11',                  // base midnight, slightly violet-warm
  bgElevated: '#0E0E14',                 // floating banners / sheets, same hue one step up
  surface1:  'rgba(255,255,255,0.035)',  // card / pill
  surface2:  'rgba(255,255,255,0.065)',  // hover / pressed
  surface3:  'rgba(255,255,255,0.10)',   // filled state
  hairline:  'rgba(255,255,255,0.06)',
  hairlineStrong: 'rgba(255,255,255,0.14)',
  discBorder: 'rgba(255,255,255,0.10)',  // PTT disc resting outline
  discTick:   'rgba(255,255,255,0.40)',  // PTT disc idle tick mark

  // Foreground — inverted, with a discipline of opacity tiers.
  fg:        'rgba(255,255,255,0.97)',
  fgMuted:   'rgba(255,255,255,0.62)',
  fgFaint:   'rgba(255,255,255,0.36)',
  fgGhost:   'rgba(255,255,255,0.16)',
  fgWhisper: 'rgba(255,255,255,0.07)',
  fgInk:     '#000000',  // text on a light/inverted surface

  // ── Speaker accents — Dusk palette ─────────────────────────────────────────
  // A is the user (warm). B is the partner (cool). Each side has three layered
  // hues (top / mid / deep) used in the bloom; the `base` is the legacy single
  // hue used by chip dots and rings. Translucent variants tuned so multiple
  // bloom layers stack into a watercolour stain on a near-black surface.

  accentA:        '#FF8E76',  // peach — the canonical warm accent
  accentASoft:    'rgba(255,142,118,0.16)',
  accentARing:    'rgba(255,142,118,0.55)',
  accentAGlow:    'rgba(255,142,118,0.10)',
  accentAWhisper: 'rgba(255,142,118,0.045)',

  accentB:        '#A8B2FF',  // periwinkle — the canonical cool accent
  accentBSoft:    'rgba(168,178,255,0.16)',
  accentBRing:    'rgba(168,178,255,0.55)',
  accentBGlow:    'rgba(168,178,255,0.10)',
  accentBWhisper: 'rgba(168,178,255,0.045)',

  // Bloom palettes for the three watercolour stains live as hex constants
  // inside `Bloom.tsx`, where the SVG <RadialGradient> per-stop alpha
  // governs intensity. Keeping a parallel rgba copy here was a footgun —
  // when we tuned alpha on the SVG side, the tokens silently rotted.

  // No seam tokens — the horizon is the natural near-black band of the
  // dusk gradient (`DuskBackdrop`), not a separate horizontal element.

  // Status — re-tinted so success aligns with the cool palette (seafoam) and
  // warning doesn't clash with the warm palette.
  ok:        '#7FD8C9',  // seafoam — coherent with cool bloom
  okBorder:  'rgba(127,216,201,0.30)',
  okSoft:    'rgba(127,216,201,0.06)',
  warn:      '#F4D06A',
  error:     '#F87171',
  errorSoft: 'rgba(248,113,113,0.16)',
  errorBorder: 'rgba(248,113,113,0.32)',
} as const;

// ── Spacing (8pt-ish) ────────────────────────────────────────────────────────

export const space = {
  xxs: 4,
  xs:  8,
  sm:  12,
  md:  16,
  lg:  20,
  xl:  24,
  xxl: 32,
  xxxl: 40,
  huge: 56,
  giant: 72,
} as const;

// ── Radii ────────────────────────────────────────────────────────────────────

export const radius = {
  xs:  6,
  sm:  10,
  md:  14,
  lg:  20,
  xl:  28,
  pill: 999,
} as const;

// ── Typography ───────────────────────────────────────────────────────────────

const sansFamily: string | undefined = Platform.select({
  ios: undefined,           // SF Pro
  android: 'sans-serif',    // Roboto
  default: undefined,
});

// System serif. iOS resolves to New York; Android resolves to Noto Serif.
// Both are humanist, both ship by default — no asset bundling, no risk.
const serifFamily: string = Platform.select({
  ios: 'Georgia',
  android: 'serif',
  default: 'serif',
});

// Mono retained for the in-app log viewer (where character alignment matters).
// Everywhere else the chrome moved to serif italic.
const monoFamily: string = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

export const font = {
  sansFamily,
  serifFamily,
  monoFamily,

  // Display — the big translation surface. Lighter weight, generous
  // line-height, negative tracking for editorial feel.
  display: {
    fontFamily: sansFamily,
    fontSize: 30,
    lineHeight: 38,
    fontWeight: '300' as const,
    letterSpacing: -0.4,
  },
  displayLarge: {
    fontFamily: sansFamily,
    fontSize: 36,
    lineHeight: 44,
    fontWeight: '300' as const,
    letterSpacing: -0.7,
  },
  displayHuge: {
    fontFamily: sansFamily,
    fontSize: 48,
    lineHeight: 56,
    fontWeight: '200' as const,
    letterSpacing: -1.0,
  },
  // Hero — the main translated text in conversation. Even more breathing.
  displayHero: {
    fontFamily: sansFamily,
    fontSize: 34,
    lineHeight: 42,
    fontWeight: '300' as const,
    letterSpacing: -0.6,
  },
  // Editorial hero — used for setup-screen headlines and chrome-y display
  // text. Serif italic, big, generous line-height. The literary voice of
  // Dusk's setup surfaces (LanguagePair, eventually Settings hero, etc).
  serifHero: {
    fontFamily: serifFamily,
    fontStyle: 'italic' as const,
    fontSize: 30,
    lineHeight: 38,
    fontWeight: '400' as const,
    letterSpacing: -0.4,
  },

  // Body
  body: {
    fontFamily: sansFamily,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '400' as const,
  },
  bodySmall: {
    fontFamily: sansFamily,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '400' as const,
  },

  // Caption — small UI labels, micro-tags
  caption: {
    fontFamily: sansFamily,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '500' as const,
    letterSpacing: 0.8,
  },

  // Serif italic — Dusk's chrome voice. Used for language codes, source-line
  // labels, microcopy, edge chrome, version tag. Softens the technical edge.
  serif: {
    fontFamily: serifFamily,
    fontStyle: 'italic' as const,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '400' as const,
    letterSpacing: 0.2,
  },
  serifSmall: {
    fontFamily: serifFamily,
    fontStyle: 'italic' as const,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '400' as const,
    letterSpacing: 0.6,
  },
  serifTiny: {
    fontFamily: serifFamily,
    fontStyle: 'italic' as const,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '400' as const,
    letterSpacing: 1.4,
  },

  // Mono — retained for the diagnostics log viewer (character alignment
  // matters there). Avoid in conversation chrome — Dusk speaks serif.
  mono: {
    fontFamily: monoFamily,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '400' as const,
    letterSpacing: 0.4,
  },
  monoSmall: {
    fontFamily: monoFamily,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '400' as const,
    letterSpacing: 0.5,
  },

  // Button label
  button: {
    fontFamily: sansFamily,
    fontSize: 15,
    lineHeight: 18,
    fontWeight: '500' as const,
    letterSpacing: 0.2,
  },
} as const;

// ── Motion ───────────────────────────────────────────────────────────────────

export const motion = {
  springSnappy:   { damping: 22, stiffness: 240, mass: 1 },
  springSoft:     { damping: 18, stiffness: 160, mass: 1 },
  springSubtle:   { damping: 28, stiffness: 320, mass: 1 },
  springBouncy:   { damping: 12, stiffness: 180, mass: 1 },

  fast:   140,
  normal: 240,
  slow:   400,
  glacial: 800,
} as const;

// ── Speaker accent helper ────────────────────────────────────────────────────

export type SpeakerSide = 'A' | 'B';

export const accentFor = (side: SpeakerSide) => ({
  base:    side === 'A' ? color.accentA    : color.accentB,
  soft:    side === 'A' ? color.accentASoft: color.accentBSoft,
  ring:    side === 'A' ? color.accentARing: color.accentBRing,
  glow:    side === 'A' ? color.accentAGlow: color.accentBGlow,
  whisper: side === 'A' ? color.accentAWhisper: color.accentBWhisper,
});
