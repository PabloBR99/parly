/**
 * The default streaming fetcher's fallback discipline: the XHR retry
 * re-POSTs from byte zero, so it is only allowed when the fetch path
 * delivered NOTHING. Once bytes have flowed, sentences are already queued
 * into TTS — a replay would speak them twice.
 */

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
}));

import { MistralTranslator } from '../MistralTranslator';

const sseChunk = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

function stubXhr(): { constructed: () => number } {
  let count = 0;
  class FakeXhr {
    onreadystatechange: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 0;
    status = 0;
    responseText = '';
    constructor() { count++; }
    open(): void {}
    setRequestHeader(): void {}
    send(): void {
      // Immediately "complete" with an empty 200 so the promise settles.
      this.readyState = 4;
      this.status = 200;
      this.onreadystatechange?.();
    }
    abort(): void {}
  }
  (global as Record<string, unknown>).XMLHttpRequest = FakeXhr as unknown;
  return { constructed: () => count };
}

const encoder = new TextEncoder();

describe('defaultFetcher fallback discipline', () => {
  const originalFetch = global.fetch;
  const originalXhr = (global as Record<string, unknown>).XMLHttpRequest;

  afterEach(() => {
    global.fetch = originalFetch;
    (global as Record<string, unknown>).XMLHttpRequest = originalXhr;
  });

  it('does NOT retry via XHR when the stream dies after bytes arrived', async () => {
    const xhr = stubXhr();
    const read = jest.fn()
      .mockResolvedValueOnce({
        done: false,
        value: encoder.encode(sseChunk('This is a long enough first sentence for emission. ')),
      })
      .mockRejectedValueOnce(new Error('connection reset mid-stream'));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => ({ read }) },
    }) as unknown as typeof fetch;

    const t = new MistralTranslator();
    const sentences: string[] = [];
    const errors: Error[] = [];
    let done = false;
    await t.translateStream({
      apiKey: 'sk',
      sourceText: 'algo',
      sourceLang: 'es',
      targetLang: 'en',
      onSentence: s => sentences.push(s),
      onDone: () => { done = true; },
      onError: e => errors.push(e),
    });

    // The mid-stream death surfaces as an error — the sentence already sent
    // to TTS is never replayed.
    expect(xhr.constructed()).toBe(0);
    expect(errors).toHaveLength(1);
    expect(done).toBe(false);
    expect(sentences.length).toBeGreaterThanOrEqual(1);
  });

  it('DOES fall back to XHR when fetch fails before any bytes', async () => {
    const xhr = stubXhr();
    global.fetch = jest.fn().mockRejectedValue(
      new TypeError('Network request failed'),
    ) as unknown as typeof fetch;

    const t = new MistralTranslator();
    const errors: Error[] = [];
    let done = false;
    await t.translateStream({
      apiKey: 'sk',
      sourceText: 'algo',
      sourceLang: 'es',
      targetLang: 'en',
      onSentence: () => {},
      onDone: () => { done = true; },
      onError: e => errors.push(e),
    });

    // Zero bytes delivered → the retry is duplicate-free and allowed.
    expect(xhr.constructed()).toBe(1);
    expect(errors).toHaveLength(0);
    expect(done).toBe(true);
  });

  it('still surfaces aborts as cancellation, not as an XHR retry', async () => {
    const xhr = stubXhr();
    const abortErr = new DOMException('aborted', 'AbortError');
    global.fetch = jest.fn().mockRejectedValue(abortErr) as unknown as typeof fetch;

    const t = new MistralTranslator();
    const errors: Error[] = [];
    await t.translateStream({
      apiKey: 'sk',
      sourceText: 'algo',
      sourceLang: 'es',
      targetLang: 'en',
      onSentence: () => {},
      onDone: () => {},
      onError: e => errors.push(e),
    });

    expect(xhr.constructed()).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/cancelled/i);
  });
});
