/**
 * AudioCaptureService — focused on the stop/start interleave that killed the
 * mic on the recovery press: stopStreaming's continuation must never remove a
 * listener registered by a NEWER startStreaming.
 */

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  PermissionsAndroid: {
    PERMISSIONS: { RECORD_AUDIO: 'android.permission.RECORD_AUDIO' },
    RESULTS: { GRANTED: 'granted' },
    check: jest.fn().mockResolvedValue(true),
    request: jest.fn().mockResolvedValue('granted'),
  },
}));

jest.mock('react-native-audio-record', () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    start: jest.fn(),
    stop: jest.fn().mockResolvedValue('/mock/file.wav'),
    on: jest.fn(),
  },
}));

import AudioRecord from 'react-native-audio-record';
import { AudioCaptureService } from '../AudioCaptureService';

describe('AudioCaptureService streaming interleave', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function trackSubscriptions(): Array<{ remove: jest.Mock }> {
    const subs: Array<{ remove: jest.Mock }> = [];
    (AudioRecord.on as jest.Mock).mockImplementation(() => {
      const sub = { remove: jest.fn() };
      subs.push(sub);
      return sub;
    });
    return subs;
  }

  it('startStreaming during an in-flight stop keeps the NEW listener alive', async () => {
    const subs = trackSubscriptions();
    let resolveStop!: (path: string) => void;
    (AudioRecord.stop as jest.Mock).mockImplementation(
      () => new Promise<string>(r => { resolveStop = r; }),
    );

    const svc = new AudioCaptureService();
    svc.startStreaming(() => {});

    // failTurn fires stopStreaming without awaiting; the native stop hangs…
    const stopPromise = svc.stopStreaming();
    // …and the user's recovery press lands mid-stop.
    svc.startStreaming(() => {});

    resolveStop('/mock/file.wav');
    await stopPromise;

    expect(subs).toHaveLength(2);
    // The old stop removed ITS OWN listener…
    expect(subs[0].remove).toHaveBeenCalledTimes(1);
    // …and never touched the new turn's — the exact bug was removing it here,
    // leaving the recovery turn recording into the void.
    expect(subs[1].remove).not.toHaveBeenCalled();
    expect(svc.isStreaming).toBe(true);
  });

  it('normal stop removes the listener only after the native stop resolves (trailing chunk)', async () => {
    const subs = trackSubscriptions();
    let resolveStop!: (path: string) => void;
    (AudioRecord.stop as jest.Mock).mockImplementation(
      () => new Promise<string>(r => { resolveStop = r; }),
    );

    const svc = new AudioCaptureService();
    svc.startStreaming(() => {});
    const stopPromise = svc.stopStreaming();

    // While the native stop is in flight, the final buffered chunk can still
    // be delivered — the listener must not be gone yet.
    expect(subs[0].remove).not.toHaveBeenCalled();

    resolveStop('/mock/file.wav');
    await stopPromise;
    expect(subs[0].remove).toHaveBeenCalledTimes(1);
    expect(svc.isStreaming).toBe(false);
  });

  it('stopStreaming is idempotent', async () => {
    trackSubscriptions();
    (AudioRecord.stop as jest.Mock).mockResolvedValue('/mock/file.wav');
    const svc = new AudioCaptureService();
    svc.startStreaming(() => {});
    await svc.stopStreaming();
    await svc.stopStreaming();
    expect(AudioRecord.stop).toHaveBeenCalledTimes(1);
  });
});
