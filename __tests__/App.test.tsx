/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

// Keep the tree hermetic: the network monitor must not probe the real
// Mistral endpoint from a unit test.
jest.mock('../src/services/network/mistralProbe', () => ({
  createMistralProbe: () => jest.fn().mockResolvedValue(true),
}));

import App from '../src/App';

test('renders correctly', async () => {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  // Unmount so App's cleanup disposes the network monitor's interval —
  // otherwise the suite leaks a worker.
  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
});
