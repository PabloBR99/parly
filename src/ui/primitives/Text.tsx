// Typography primitives — a thin layer over RN's <Text> that maps to our
// design tokens. Use these instead of raw <Text> + StyleSheet so font roles
// are consistent across screens.

import React from 'react';
import { Platform, Text as RNText, type TextProps as RNTextProps, type StyleProp, type TextStyle } from 'react-native';
import { color, font } from '../theme';

type Variant =
  | 'display'
  | 'displayLarge'
  | 'displayHuge'
  | 'displayHero'
  | 'serifHero'
  | 'body'
  | 'bodySmall'
  | 'caption'
  | 'serif'
  | 'serifSmall'
  | 'serifTiny'
  | 'mono'
  | 'monoSmall'
  | 'button';

type Tone = 'fg' | 'fgMuted' | 'fgFaint' | 'fgGhost' | 'fgInk' | 'error' | 'warn' | 'ok';

interface TextProps extends RNTextProps {
  readonly variant?: Variant;
  readonly tone?: Tone;
  readonly style?: StyleProp<TextStyle>;
}

const toneToColor: Record<Tone, string> = {
  fg:      color.fg,
  fgMuted: color.fgMuted,
  fgFaint: color.fgFaint,
  fgGhost: color.fgGhost,
  fgInk:   color.fgInk,
  error:   color.error,
  warn:    color.warn,
  ok:      color.ok,
};

// Non-breaking space — appended to italic / letter-spaced text on Android.
// See `trailingTailFor` for the rationale.
const NBSP = '\u00A0';

export function Text({
  variant = 'body',
  tone = 'fg',
  style,
  children,
  ...rest
}: TextProps): React.JSX.Element {
  const variantStyle = font[variant];
  // Android RN drops the trailing character of italic text and text with
  // positive `letterSpacing` — Noto Serif italic at 10 pt renders
  // "ENGLISH" as "ENGLIS", "listening" → "listenin". The canvas clip
  // snaps to Paint's measured advance width, so the italic stem
  // overhanging past the last advance (or the trailing letter-spacing
  // tail) falls outside the draw rect. `paddingEnd` widens the layout
  // box but not the inner draw rect, so it doesn't help. The reliable
  // fix is to push the real last letter inward by appending an
  // invisible non-breaking space — that character takes the cut spot
  // instead of the visible glyph. Android-only because iOS computes
  // glyph bounds correctly. NBSP (rather than a regular space) because
  // Android's StaticLayout can elide trailing ASCII whitespace from
  // `getLineMax`, which would defeat the fix.
  const tail = trailingTailFor(variantStyle);
  return (
    <RNText
      {...rest}
      style={[variantStyle, { color: toneToColor[tone] }, style]}>
      {children}
      {tail}
    </RNText>
  );
}

function trailingTailFor(variantStyle: Record<string, unknown>): string | null {
  if (Platform.OS !== 'android') return null;
  const ls = variantStyle.letterSpacing;
  const isItalic = variantStyle.fontStyle === 'italic';
  const hasPositiveLs = typeof ls === 'number' && ls > 0;
  return isItalic || hasPositiveLs ? NBSP : null;
}
