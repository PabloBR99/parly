// Parly design tokens — "Diplomatic" theme.
//
// Aesthetic: editorial dark. Black surface, restrained palette, two quiet
// accent hues — warm platinum-amber for "you" / Person A, cool ice-blue for
// "them" / Person B. Mono for technical detail; system sans for everything
// else. No drop shadows on dark — depth comes from concentric translucent
// halos and tiered opacity, never from grey rectangles.

import { Platform } from 'react-native';

// ── Color ────────────────────────────────────────────────────────────────────

export const color = {
  // Surfaces — true black base, then progressively warmer neutrals on top.
  bg:        '#000000',
  surface1:  'rgba(255,255,255,0.035)',  // card / pill
  surface2:  'rgba(255,255,255,0.065)',  // hover / pressed
  surface3:  'rgba(255,255,255,0.10)',   // filled state
  hairline:  'rgba(255,255,255,0.06)',
  hairlineStrong: 'rgba(255,255,255,0.14)',

  // Foreground — inverted, with a discipline of opacity tiers.
  fg:        'rgba(255,255,255,0.97)',
  fgMuted:   'rgba(255,255,255,0.62)',
  fgFaint:   'rgba(255,255,255,0.36)',
  fgGhost:   'rgba(255,255,255,0.16)',
  fgWhisper: 'rgba(255,255,255,0.07)',
  fgInk:     '#000000',  // text on a light/inverted surface

  // Speaker accents — chosen so they never compete with text. Used sparingly:
  // ring around active mic, quiet halo around idle mic, micro-tag.
  accentA:        '#F2B473',  // platinum amber — "you"
  accentASoft:    'rgba(242,180,115,0.16)',
  accentARing:    'rgba(242,180,115,0.55)',
  accentAGlow:    'rgba(242,180,115,0.10)',  // outermost halo tint
  accentAWhisper: 'rgba(242,180,115,0.045)', // far-field glow

  accentB:        '#86BFFF',  // ice blue — "them"
  accentBSoft:    'rgba(134,191,255,0.16)',
  accentBRing:    'rgba(134,191,255,0.55)',
  accentBGlow:    'rgba(134,191,255,0.10)',
  accentBWhisper: 'rgba(134,191,255,0.045)',

  // Status
  ok:        '#7CD9A0',
  warn:      '#F4D06A',
  error:     '#F87171',
  errorSoft: 'rgba(248,113,113,0.16)',
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

const monoFamily: string = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

export const font = {
  sansFamily,
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

  // Mono — technical (lang code, model id, durations)
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
