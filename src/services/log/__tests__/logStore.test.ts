/**
 * logStore — the crash trail.
 *
 * The whole point of this store is that a release-signed APK shows no red box
 * and this device can't be attached to logcat, so the file it leaves behind is
 * the only account of what happened. A crash that leaves nothing is the one
 * failure mode it must not have.
 */

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn().mockResolvedValue(false),
  readFile: jest.fn().mockResolvedValue(''),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}), { virtual: true });

import { swappableGlobals as globals } from '../../../testing/globals';

/** RN's global error handler, whose `isFatal` is optional on its contract. */
type Handler = (e: Error, isFatal?: boolean) => void;

interface Harness {
  readonly order: string[];
  readonly fire: Handler;
}

/** Boot a fresh log store with a stub ErrorUtils, and record the order of the
 *  two things that matter: the trail reaching disk, and the handoff that ends
 *  the process. */
async function boot(): Promise<Harness> {
  jest.resetModules();
  const order: string[] = [];

  const RNFS = require('@dr.pogodin/react-native-fs');
  RNFS.writeFile.mockImplementation(async (_path: string, contents: string) => {
    if (contents.includes('boom')) order.push('trail-written');
  });

  let captured: Handler = () => {};
  globals.ErrorUtils = {
    setGlobalHandler: (h: Handler) => { captured = h; },
    getGlobalHandler: () => () => { order.push('handoff'); },
  };

  const { initLogStore } = require('../logStore');
  await initLogStore();

  return { order, fire: (e, f) => captured(e, f) };
}

afterEach(() => {
  delete globals.ErrorUtils;
});

describe('logStore — a fatal error leaves a trail', () => {
  it('gets the crash entry onto disk before handing the crash on', async () => {
    const { order, fire } = await boot();

    fire(new Error('boom'), true);
    await new Promise<void>(r => setTimeout(r, 50));

    // Handing off is what ends the process. Done first — as it was — the
    // asynchronous write behind it never lands, and the crash that killed the
    // app is the one event missing from the account of it.
    expect(order).toEqual(['trail-written', 'handoff']);
  });

  it('does not make ordinary errors wait for the disk', async () => {
    const { order, fire } = await boot();

    fire(new Error('boom'), false);

    // Nothing is dying, so nothing is racing: the handoff is synchronous and
    // the write settles on its own schedule.
    expect(order).toEqual(['handoff']);
  });

  it('reports the crash even if the disk never answers', async () => {
    const { order, fire } = await boot();
    const RNFS = require('@dr.pogodin/react-native-fs');
    RNFS.writeFile.mockImplementation(() => new Promise<void>(() => {}));

    fire(new Error('boom'), true);
    await new Promise<void>(r => setTimeout(r, 600));

    // A wedged filesystem must not be able to swallow a crash report.
    expect(order).toEqual(['handoff']);
  });
});
