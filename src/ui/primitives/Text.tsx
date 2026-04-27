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
  return (
    <RNText
      {...rest}
      style={[variantStyle, { color: toneToColor[tone] }, style]}>
      {children}
    </RNText>
  );
}
