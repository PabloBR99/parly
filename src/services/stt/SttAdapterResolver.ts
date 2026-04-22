// SttAdapterResolver — picks which STT adapter to use for the next utterance.
//
// Inputs (in priority order):
//   1. User override — sttTransport='online' or 'offline' forces the choice.
//   2. Network state — when sttTransport='auto', online is preferred while
//      NetworkMonitor reports 'online'; otherwise we fall back to offline.
//
// 'unknown' network state is treated as 'not confirmed online' → offline in auto
// mode. The orchestrator drives a probeNow() before the first utterance so the
// monitor leaves 'unknown' quickly; until then we don't risk a sluggish first
// utterance on a flaky network.

import { offlineSttAdapter } from './OfflineSttAdapter';
import { onlineSttAdapter } from './OnlineSttAdapter';
import { useSettingsStore } from '../../store/settingsStore';
import { useNetworkStore } from '../../store/networkStore';
import type { SttAdapter } from './SttAdapter';

export function resolveSttAdapter(): SttAdapter {
  const { sttTransport } = useSettingsStore.getState();
  const networkState = useNetworkStore.getState().state;

  if (sttTransport === 'offline') return offlineSttAdapter;
  if (sttTransport === 'online') return onlineSttAdapter;
  // auto: only go online when the monitor has *confirmed* connectivity.
  if (sttTransport === 'auto' && networkState === 'online') return onlineSttAdapter;
  return offlineSttAdapter;
}
