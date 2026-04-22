// Network store — mirrors NetworkMonitor snapshot for UI consumption.
//
// Any component can `useNetworkStore(s => s.state)` to reactively show
// an online/offline badge. The monitor itself is the source of truth;
// this store just publishes snapshots via a subscription wired from app init.

import { create } from 'zustand';
import type { NetworkMonitor, NetworkSnapshot, NetworkState } from '../services/network/NetworkMonitor';

interface NetworkStoreState {
  readonly state: NetworkState;
  readonly lastProbeOk: boolean;
  readonly lastChangedAt: number;
}

interface NetworkStoreActions {
  _applySnapshot: (snapshot: NetworkSnapshot) => void;
}

export const useNetworkStore = create<NetworkStoreState & NetworkStoreActions>(set => ({
  state: 'unknown',
  lastProbeOk: false,
  lastChangedAt: 0,

  _applySnapshot: snapshot =>
    set({
      state: snapshot.state,
      lastProbeOk: snapshot.lastProbeOk,
      lastChangedAt: snapshot.lastChangedAt,
    }),
}));

/**
 * Wire a NetworkMonitor to the store. Returns an unsubscribe function.
 * Call once at app init after creating the monitor.
 */
export function bindNetworkMonitorToStore(monitor: NetworkMonitor): () => void {
  useNetworkStore.getState()._applySnapshot(monitor.getSnapshot());
  return monitor.subscribe(snapshot => {
    useNetworkStore.getState()._applySnapshot(snapshot);
  });
}
