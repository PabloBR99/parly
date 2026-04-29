// Typography primitives — a thin layer over RN's <Text> that maps to our
// design tokens. Use these instead of raw <Text> + StyleSheet so font roles
// are consistent across screens.

import React from 'react';
import { Text as RNText, type TextProps as RNTextProps, type StyleProp, type TextStyle } from 'react-native';
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

export function Text({
  variant = 'body',
  tone = 'fg',
  style,
  children,
  ...rest
}: TextProps): React.JSX.Element {
  const variantStyle = font[variant];
  // Android RN under-measures Text whose font has positive `letterSpacing`:
  // the trailing letter's spacing is added to the layout box but not to the
  // glyph clip, so the last character is cut off (`english` → `englis`,
  // `listening` → `listenin`). Compensate with a tiny paddingEnd that
  // matches the variant's letterSpacing so the clip rect always has room
  // for the final glyph.
  const trailingPad = variantTrailingPad(variantStyle);
  return (
    <RNText
      {...rest}
      style={[variantStyle, trailingPad, { color: toneToColor[tone] }, style]}>
      {children}
    </RNText>
  );
}

function variantTrailingPad(
  variantStyle: Record<string, unknown>,
): { readonly paddingEnd: number } | undefined {
  const ls = variantStyle.letterSpacing;
  if (typeof ls !== 'number' || ls <= 0) return undefined;
  // Round up to whole pixel; sub-pixel paddings are flaky on Android.
  return { paddingEnd: Math.ceil(ls) };
}
