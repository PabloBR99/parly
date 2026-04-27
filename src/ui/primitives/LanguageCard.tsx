// LanguageCard — large typographic card representing one speaker's slot.
// Empty state shows a placeholder; filled state shows the endonym in big
// type, the English name + emoji as supporting metadata.

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Text } from './Text';
import { color, motion, radius, space } from '../theme';
import type { Language } from '../../app/types';

interface LanguageCardProps {
  /** Top card belongs to the partner, bottom card to the user. The label
   *  text changes accordingly. */
  readonly role: 'partner' | 'self';
  readonly language: Language | null;
  readonly accent: string;
  readonly onPress: () => void;
  readonly onClear?: () => void;
}

export function LanguageCard({
  role,
  language,
  accent,
  onPress,
  onClear,
}: LanguageCardProps): React.JSX.Element {
  const press = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - 0.02 * press.value }],
    opacity: 1 - 0.05 * press.value,
  }));

  const filled = language !== null;
  const roleLabel = role === 'partner' ? 'Other language' : 'Your language';

  return (
    <Pressable
      onPressIn={() => {
        press.value = withSpring(1, motion.springSnappy);
      }}
      onPressOut={() => {
        press.value = withSpring(0, motion.springSnappy);
      }}
      onPress={onPress}
      onLongPress={onClear}
      accessibilityRole="button"
      accessibilityLabel={
        filled
          ? `${roleLabel}: ${language!.name}. Tap to change, long-press to clear.`
          : `${roleLabel}. Tap to choose.`
      }>
      <Animated.View
        style={[
          styles.card,
          filled ? styles.cardFilled : styles.cardEmpty,
          filled && { borderColor: `${accent}38` },
          animatedStyle,
        ]}>
        <View style={styles.metaRow}>
          <View style={[styles.dot, { backgroundColor: filled ? accent : color.fgGhost }]} />
          <Text variant="caption" tone="fgFaint" style={styles.metaLabel}>
            {roleLabel.toUpperCase()}
          </Text>
        </View>

        {filled ? (
          <View>
            <Text variant="displayHuge" tone="fg" style={styles.endonym}>
              {language!.endonym}
            </Text>
            <View style={styles.subRow}>
              <Text style={styles.emoji}>{language!.emoji}</Text>
              <Text variant="bodySmall" tone="fgFaint">
                {language!.name}
              </Text>
              <Text variant="mono" tone="fgGhost" style={styles.code}>
                {language!.code.toUpperCase()}
              </Text>
            </View>
          </View>
        ) : (
          <Text variant="displayLarge" tone="fgGhost" style={styles.placeholder}>
            Tap to choose
          </Text>
        )}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.lg,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 132,
    justifyContent: 'space-between',
  },
  cardEmpty: {
    backgroundColor: 'transparent',
    borderColor: color.hairline,
  },
  cardFilled: {
    backgroundColor: color.surface1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: space.xs,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 8,
  },
  metaLabel: {
    letterSpacing: 1.4,
  },
  endonym: {
    marginTop: 4,
  },
  placeholder: {
    marginTop: space.xs,
    fontWeight: '300',
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.sm,
  },
  emoji: {
    fontSize: 16,
    marginRight: space.xs,
  },
  code: {
    marginLeft: 'auto',
    letterSpacing: 1.2,
  },
});
