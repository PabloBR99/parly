// Shared NetworkMonitor singleton.
//
// The orchestrator needs a way to say "the online request just failed, re-check
// connectivity now" without re-creating the monitor every time. App.tsx owns
// the lifecycle: creates the singleton, binds it to the store, starts/stops it.
// Everything else imports `networkMonitor` here.

import { NetworkMonitor, createDefaultProbe, type NetworkMonitorOptions } from './NetworkMonitor';
import { bindNetworkMonitorToStore } from '../../store/networkStore';

let instance: NetworkMonitor | null = null;
let unbind: (() => void) | null = null;

/**
 * Initialize the singleton. Safe to call multiple times — subsequent calls are no-ops.
 * Options can be overridden for tests or custom probe URLs.
 */
export function initNetworkMonitor(options?: Partial<NetworkMonitorOptions>): NetworkMonitor {
  if (instance) return instance;
  const probe = options?.probe ?? createDefaultProbe();
  instance = new NetworkMonitor({ ...options, probe });
  unbind = bindNetworkMonitorToStore(instance);
  return instance;
}

/** Current monitor instance, or null if not initialized yet. */
export function getNetworkMonitor(): NetworkMonitor | null {
  return instance;
}

/** Stop probing and clear the singleton. For app teardown and tests. */
export function disposeNetworkMonitor(): void {
  instance?.stop();
  unbind?.();
  instance = null;
  unbind = null;
}

/**
 * Best-effort immediate probe. No-op if the monitor isn't initialized.
 * The orchestrator calls this after an online failure to hasten the
 * online→offline flip without waiting for the next scheduled probe.
 */
export function probeNetworkNow(): void {
  void instance?.probeNow();
}
