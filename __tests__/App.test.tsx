/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import App from '../src/App';
import type { ProbeFn } from '../src/services/network/NetworkMonitor';

// Keep the tree hermetic: the network monitor must not probe the real Mistral
// endpoint from a unit test, so App is handed one that always answers yes.
const alwaysReachable: ProbeFn = async () => true;

test('renders correctly', async () => {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App probe={alwaysReachable} />);
  });
  // Unmount so App's cleanup disposes the network monitor's interval —
  // otherwise the suite leaks a worker.
  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
});
