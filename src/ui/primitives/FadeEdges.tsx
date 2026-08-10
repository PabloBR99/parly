// FadeEdges — dissolves a scrolling region's top and bottom ends into nothing.
//
// A mask, not a scrim. The difference is the whole point:
//
//   A scrim is a dark overlay painted *on top of* the region. It hides text by
//   darkening everything under it — including the background — so its own
//   boundary is a step in background brightness. Against near-black that step
//   reads as a line, which is how an overlay meant to be invisible ends up
//   drawing the outline of its container. There is no way to soften this away;
//   the edge is what the technique is.
//
//   A mask sets the *alpha* of the region's own pixels. Where the mask is
//   transparent, the text is simply not there — and the background behind it is
//   untouched. Nothing is added to the scene, so there is nothing to have an
//   edge.
//
// Why the caller must also pad the scroll content by `height`:
//   The mask is static — it always fades the two bands. Padding the content by
//   the same amount parks the resting text below the top band and above the
//   bottom one, so nothing is dimmed while it fits; text only dissolves as it
//   travels through a band on its way out of view. That keeps the newest line
//   at full strength, which is the one line that always matters.
//
// The fallback:
//   RNCMaskedView is a legacy Android ViewGroupManager reached through Fabric's
//   interop layer (on by default in this React Native). If that ever stops
//   resolving, rendering it would throw on the app's main screen. So we ask the
//   registry first and, failing that, render the children plain — no fade, but
//   also no crash and no edge.

import React from 'react';
import { StyleSheet, UIManager, View, type StyleProp, type ViewStyle } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import LinearGradient from 'react-native-linear-gradient';

/** Opaque = keep, transparent = dissolve. Only the alpha channel is read. */
const KEEP = '#000000';
const GONE = 'transparent';
const TOP_BAND = [GONE, KEEP];
const BOTTOM_BAND = [KEEP, GONE];

let maskSupported: boolean | null = null;
function isMaskSupported(): boolean {
  if (maskSupported === null) {
    try {
      maskSupported = UIManager.hasViewManagerConfig('RNCMaskedView');
    } catch {
      maskSupported = false;
    }
  }
  return maskSupported;
}

interface FadeEdgesProps {
  /** Height of each fade band, in points. Pad the scroll content to match. */
  readonly height: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: React.ReactNode;
}

export function FadeEdges({ height, style, children }: FadeEdgesProps): React.JSX.Element {
  if (!isMaskSupported()) {
    return <View style={style}>{children}</View>;
  }

  return (
    <MaskedView
      style={style}
      maskElement={
        <View style={styles.mask}>
          <LinearGradient colors={TOP_BAND} style={{ height }} />
          <View style={styles.keep} />
          <LinearGradient colors={BOTTOM_BAND} style={{ height }} />
        </View>
      }>
      {children}
    </MaskedView>
  );
}

const styles = StyleSheet.create({
  mask: {
    flex: 1,
    backgroundColor: GONE,
  },
  keep: {
    flex: 1,
    backgroundColor: KEEP,
  },
});
