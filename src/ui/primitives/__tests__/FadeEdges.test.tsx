import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

// The native mask is a legacy Android ViewGroupManager reached through Fabric's
// interop layer. These tests cover the one property that must hold whatever the
// registry says: the wrapped content renders. A fade is a nicety; the
// conversation history is not.

type Registry = boolean | 'throws';

function renderWith(registry: Registry): ReactTestRenderer.ReactTestRenderer {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // Only RNCMaskedView is under test. Every other name answers `true` — React
  // Native's own Text consults the same registry, and this is already a stub
  // under the jest preset, so there is no original behaviour to delegate to.
  const uiManager = require('react-native').UIManager;
  jest.spyOn(uiManager, 'hasViewManagerConfig').mockImplementation((...args: unknown[]) => {
    if (args[0] !== 'RNCMaskedView') return true;
    if (registry === 'throws') throw new Error('registry unavailable');
    return registry;
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { FadeEdges } = require('../FadeEdges');

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <FadeEdges height={18}>
        <Text>history</Text>
      </FadeEdges>,
    );
  });
  if (tree === undefined) throw new Error('act() returned without rendering FadeEdges');
  return tree;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('FadeEdges', () => {
  it('renders its children when the native mask is available', () => {
    const tree = renderWith(true);
    expect(JSON.stringify(tree.toJSON())).toContain('history');
    ReactTestRenderer.act(() => tree.unmount());
  });

  it('falls back to plain children when the native mask is missing', () => {
    const tree = renderWith(false);
    expect(JSON.stringify(tree.toJSON())).toContain('history');
    ReactTestRenderer.act(() => tree.unmount());
  });

  it('falls back rather than throwing when the registry itself throws', () => {
    const tree = renderWith('throws');
    expect(JSON.stringify(tree.toJSON())).toContain('history');
    ReactTestRenderer.act(() => tree.unmount());
  });
});
