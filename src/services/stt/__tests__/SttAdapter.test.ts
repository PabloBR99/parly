/**
 * Adapter + resolver unit tests.
 *
 * Run with:  npx jest src/services/stt/__tests__/SttAdapter
 */

// ── Mocks (hoisted before imports) ────────────────────────────────────────────

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
}));

jest.mock('../WhisperService', () => ({
  whisperService: {
    transcribe: jest.fn().mockResolvedValue({ text: 'hello world', language: 'en' }),
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { whisperService } from '../WhisperService';
import { offlineSttAdapter } from '../OfflineSttAdapter';
import { resolveSttAdapter } from '../SttAdapterResolver';
import { useSettingsStore } from '../../../store/settingsStore';
import { useNetworkStore } from '../../../store/networkStore';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OfflineSttAdapter', () => {
  beforeEach(() => {
    (whisperService.transcribe as jest.Mock).mockClear();
  });

  it('has name "offline"', () => {
    expect(offlineSttAdapter.name).toBe('offline');
  });

  it('delegates to whisperService.transcribe with the same arguments', async () => {
    const result = await offlineSttAdapter.transcribe('/tmp/audio.wav', 'es');
    expect(whisperService.transcribe).toHaveBeenCalledWith('/tmp/audio.wav', 'es');
    expect(result).toEqual({ text: 'hello world', language: 'en' });
  });

  it('forwards undefined language hint', async () => {
    await offlineSttAdapter.transcribe('/tmp/audio.wav');
    expect(whisperService.transcribe).toHaveBeenCalledWith('/tmp/audio.wav', undefined);
  });
});

describe('resolveSttAdapter', () => {
  beforeEach(() => {
    useSettingsStore.setState({ sttTransport: 'auto' });
    useNetworkStore.setState({ state: 'unknown', lastProbeOk: false, lastChangedAt: 0 });
  });

  it('returns offline when sttTransport is "offline" even if network is online', () => {
    useSettingsStore.setState({ sttTransport: 'offline' });
    useNetworkStore.setState({ state: 'online', lastProbeOk: true, lastChangedAt: 0 });
    expect(resolveSttAdapter().name).toBe('offline');
  });

  it('returns online when sttTransport is "online" regardless of network state', () => {
    useSettingsStore.setState({ sttTransport: 'online' });
    useNetworkStore.setState({ state: 'offline', lastProbeOk: false, lastChangedAt: 0 });
    // The user explicitly asked for online — honor it. The adapter itself will fail
    // loudly if unreachable; that's a clearer UX than silently going offline.
    expect(resolveSttAdapter().name).toBe('online');
  });

  it('returns online in auto mode when network is confirmed online', () => {
    useSettingsStore.setState({ sttTransport: 'auto' });
    useNetworkStore.setState({ state: 'online', lastProbeOk: true, lastChangedAt: 0 });
    expect(resolveSttAdapter().name).toBe('online');
  });

  it('returns offline in auto mode when network is offline', () => {
    useSettingsStore.setState({ sttTransport: 'auto' });
    useNetworkStore.setState({ state: 'offline', lastProbeOk: false, lastChangedAt: 0 });
    expect(resolveSttAdapter().name).toBe('offline');
  });

  it('returns offline in auto mode when network is unknown (conservative default)', () => {
    useSettingsStore.setState({ sttTransport: 'auto' });
    useNetworkStore.setState({ state: 'unknown', lastProbeOk: false, lastChangedAt: 0 });
    expect(resolveSttAdapter().name).toBe('offline');
  });
});
