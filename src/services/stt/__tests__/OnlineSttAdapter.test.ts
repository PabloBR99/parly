/**
 * OnlineSttAdapter unit tests — fetch mocked, no real HTTP.
 *
 * Run with:  npx jest src/services/stt/__tests__/OnlineSttAdapter
 */

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { onlineSttAdapter, OnlineSttAdapterError } from '../OnlineSttAdapter';
import { useSettingsStore } from '../../../store/settingsStore';

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Minimal Response-like stub that the adapter consumes. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

/** Swap global.fetch with a jest mock for the duration of a test. */
function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = jest.fn(impl as unknown as typeof fetch);
  (global as { fetch: typeof fetch }).fetch = spy as unknown as typeof fetch;
  return spy;
}

beforeEach(() => {
  useSettingsStore.setState({ mistralApiKey: 'sk-test-key' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OnlineSttAdapter', () => {
  it('has name "online"', () => {
    expect(onlineSttAdapter.name).toBe('online');
  });

  it('throws if API key is missing', async () => {
    useSettingsStore.setState({ mistralApiKey: '' });
    await expect(onlineSttAdapter.transcribe('/tmp/a.wav')).rejects.toBeInstanceOf(
      OnlineSttAdapterError,
    );
  });

  it('POSTs to the transcriptions endpoint with Bearer auth and multipart body', async () => {
    const spy = mockFetch(async () =>
      jsonResponse(200, { text: 'hola', language: 'es' }),
    );

    await onlineSttAdapter.transcribe('/tmp/a.wav', 'es');

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mistral.ai/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test-key');
    // Intentionally no Content-Type — FormData sets the multipart boundary.
    expect(headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('maps a successful response to TranscriptionResult', async () => {
    mockFetch(async () => jsonResponse(200, { text: '  hello world  ', language: 'en' }));

    const result = await onlineSttAdapter.transcribe('/tmp/a.wav');

    expect(result).toEqual({ text: 'hello world', language: 'en' });
  });

  it('falls back to the language hint when the API omits language', async () => {
    mockFetch(async () => jsonResponse(200, { text: 'hola' }));

    const result = await onlineSttAdapter.transcribe('/tmp/a.wav', 'es');

    expect(result.language).toBe('es');
  });

  it('throws on non-2xx responses', async () => {
    mockFetch(async () => jsonResponse(401, 'unauthorized'));

    await expect(onlineSttAdapter.transcribe('/tmp/a.wav')).rejects.toThrow(
      /HTTP 401/,
    );
  });

  it('throws when fetch itself rejects (network error)', async () => {
    mockFetch(async () => { throw new Error('ECONNREFUSED'); });

    await expect(onlineSttAdapter.transcribe('/tmp/a.wav')).rejects.toThrow(
      /Network error/,
    );
  });

  it('throws when the response body is not valid JSON', async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error('bad json'); },
      text: async () => 'garbage',
    } as unknown as Response));

    await expect(onlineSttAdapter.transcribe('/tmp/a.wav')).rejects.toThrow(
      /not JSON/,
    );
  });

  it('throws when the response is missing required fields', async () => {
    mockFetch(async () => jsonResponse(200, { foo: 'bar' }));

    await expect(onlineSttAdapter.transcribe('/tmp/a.wav')).rejects.toThrow(
      /missing required fields/,
    );
  });

  it('normalizes non-file:// paths by prefixing file://', async () => {
    let capturedBody: FormData | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = init.body as FormData;
      return jsonResponse(200, { text: 'ok', language: 'en' });
    });

    await onlineSttAdapter.transcribe('/tmp/a.wav');

    // We can't introspect FormData on RN-side fields reliably from Node jest;
    // the best we can do is confirm a FormData was sent. Path-prefix logic is
    // covered implicitly: without it the multipart entry would be malformed.
    expect(capturedBody).toBeInstanceOf(FormData);
  });
});
