/**
 * createMistralProbe unit tests — fetch mocked.
 */

import { createMistralProbe } from '../mistralProbe';
import { useSettingsStore } from '../../../store/settingsStore';
import { globals } from '../../../testing/globals';

/** What createMistralProbe puts on the wire. The probe reads nothing else off
 *  the response than a status, which is the whole reachability question. */
interface ProbeRequest {
  readonly method: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

function mockFetch(impl: (url: string, init: ProbeRequest) => Promise<{ status: number }>) {
  const spy = jest.fn((url: string, init: ProbeRequest) => impl(url, init));
  globals.fetch = spy;
  return spy;
}

afterEach(() => {
  jest.restoreAllMocks();
  useSettingsStore.setState({ mistralApiKey: '' });
});

describe('createMistralProbe', () => {
  it('calls HEAD on the host when no API key is set', async () => {
    useSettingsStore.setState({ mistralApiKey: '' });
    const spy = mockFetch(async () => ({ status: 200 }));

    const probe = createMistralProbe();
    const ok = await probe(3000);

    expect(ok).toBe(true);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://api.mistral.ai/');
    expect(init.method).toBe('HEAD');
    // No auth header expected without a key
    expect(init.headers).toBeUndefined();
  });

  it('calls GET /v1/models with Bearer token when API key is set', async () => {
    useSettingsStore.setState({ mistralApiKey: 'sk-abc' });
    const spy = mockFetch(async () => ({ status: 200 }));

    const probe = createMistralProbe();
    const ok = await probe(3000);

    expect(ok).toBe(true);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://api.mistral.ai/v1/models');
    expect(init.method).toBe('GET');
    expect(init.headers?.Authorization).toBe('Bearer sk-abc');
  });

  it('treats 401 as reachable (true) — lets the STT adapter surface auth errors', async () => {
    useSettingsStore.setState({ mistralApiKey: 'sk-bad' });
    mockFetch(async () => ({ status: 401 }));
    const ok = await createMistralProbe()(3000);
    expect(ok).toBe(true);
  });

  it('treats 5xx as unreachable (false)', async () => {
    useSettingsStore.setState({ mistralApiKey: 'sk-ok' });
    mockFetch(async () => ({ status: 503 }));
    const ok = await createMistralProbe()(3000);
    expect(ok).toBe(false);
  });

  it('returns false when fetch throws (network error)', async () => {
    useSettingsStore.setState({ mistralApiKey: 'sk-ok' });
    mockFetch(async () => { throw new Error('ECONNREFUSED'); });
    const ok = await createMistralProbe()(3000);
    expect(ok).toBe(false);
  });

  it('reads the API key freshly on each invocation', async () => {
    const spy = mockFetch(async () => ({ status: 200 }));
    const probe = createMistralProbe();

    useSettingsStore.setState({ mistralApiKey: '' });
    await probe(3000);
    useSettingsStore.setState({ mistralApiKey: 'sk-new' });
    await probe(3000);

    const calls = spy.mock.calls;
    expect(calls[0][0]).toBe('https://api.mistral.ai/');
    expect(calls[1][0]).toBe('https://api.mistral.ai/v1/models');
  });
});
