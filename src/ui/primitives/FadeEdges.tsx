// FadeEdges — dissolves a scrolling region's top and bottom ends into nothing.
//
// A mask, not a scrim, and the difference is the whole point. A scrim darkens
// everything under it — background included — so its own boundary is a step in
// brightness, and against near-black that step reads as a line: an overlay
// meant to be invisible drawing the outline of its container. The edge IS the
// technique. A mask instead sets the alpha of the region's own pixels, leaving
// the background untouched: nothing is added to the scene, so nothing has an
// edge.
//
// The caller must pad the scroll content by `height` too. The mask always fades
// its two bands, so matching padding parks resting text clear of them — text
// dissolves only while travelling through a band on its way out of view, and
// the newest line always stays at full strength.
//
// RNCMaskedView is a legacy Android ViewGroupManager reached through Fabric's
// interop layer, so if it ever stops resolving, rendering it would throw on the
// app's main screen. We ask the registry first and otherwise render the children
// plain: no fade, but no crash and no edge either.

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
  mask: { flex: 1, backgroundColor: GONE },
  keep: { flex: 1, backgroundColor: KEEP },
});
