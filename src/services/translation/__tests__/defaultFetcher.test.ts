/**
 * The default streaming fetcher's transport discipline.
 *
 * Two rules, and the second one was learned the hard way on a device: the XHR
 * attempt re-POSTs from byte zero, so it is only allowed when the fetch path
 * delivered NOTHING (a replay would speak queued sentences twice) — and it
 * must never be reached by *asking* a fetch that cannot stream, because that
 * question costs a whole completed translation before the real one begins.
 */

import { MistralTranslator } from '../MistralTranslator';
import { globals } from '../../../testing/globals';

const sseChunk = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

function stubXhr(): { constructed(): number } {
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
  globals.XMLHttpRequest = FakeXhr;
  return { constructed: () => count };
}

const encoder = new TextEncoder();

describe('defaultFetcher fallback discipline', () => {
  const originalFetch = globals.fetch;
  const originalXhr = globals.XMLHttpRequest;

  afterEach(() => {
    globals.fetch = originalFetch;
    globals.XMLHttpRequest = originalXhr;
  });

  it('does NOT retry via XHR when the stream dies after bytes arrived', async () => {
    const xhr = stubXhr();
    const read = jest.fn()
      .mockResolvedValueOnce({
        done: false,
        value: encoder.encode(sseChunk('This is a long enough first sentence for emission. ')),
      })
      .mockRejectedValueOnce(new Error('connection reset mid-stream'));
    globals.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => ({ read }) },
    }
    );

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
    globals.fetch = jest.fn().mockRejectedValue(
      new TypeError('Network request failed'),
    );

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
    globals.fetch = jest.fn().mockRejectedValue(abortErr
    );

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

describe('defaultFetcher transport choice', () => {
  const originalFetch = globals.fetch;
  const originalXhr = globals.XMLHttpRequest;
  const originalResponse = globals.Response;

  afterEach(() => {
    globals.fetch = originalFetch;
    globals.XMLHttpRequest = originalXhr;
    globals.Response = originalResponse;
    jest.resetModules();
  });

  it('never calls a fetch that cannot stream — that question costs a whole translation', async () => {
    const xhr = stubXhr();
    // React Native's Response (whatwg-fetch) has no `body` at all. Asking it
    // anyway means one complete request, discarded, ahead of the real one.
    class BodylessResponse {}
    globals.Response = BodylessResponse;
    const fetchSpy = jest.fn();
    globals.fetch = fetchSpy;

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MistralTranslator: Fresh } = require('../MistralTranslator');
    const t = new Fresh();
    let done = false;
    await t.translateStream({
      apiKey: 'sk',
      sourceText: 'algo',
      sourceLang: 'es',
      targetLang: 'en',
      onSentence: () => {},
      onDone: () => { done = true; },
      onError: () => {},
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhr.constructed()).toBe(1);
    expect(done).toBe(true);
  });

  it('uses fetch when the runtime really can stream, and only once', async () => {
    const xhr = stubXhr();
    const read = jest.fn()
      .mockResolvedValueOnce({ done: false, value: encoder.encode(sseChunk('Hello there, friend. ')) })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => ({ read }) },
    });
    globals.fetch = fetchSpy;

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MistralTranslator: Fresh } = require('../MistralTranslator');
    const t = new Fresh();
    const sentences: string[] = [];
    await t.translateStream({
      apiKey: 'sk',
      sourceText: 'algo',
      sourceLang: 'es',
      targetLang: 'en',
      onSentence: (s: string) => sentences.push(s),
      onDone: () => {},
      onError: () => {},
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(xhr.constructed()).toBe(0);
    expect(sentences).toContain('Hello there, friend.');
  });
});

// ── Cancellation without DOMException ────────────────────────────────────────
//
// Hermes has no `DOMException`. Constructing one to signal cancellation threw
// a ReferenceError from inside the signal's abort listener, so the error came
// back out of `controller.abort()` at the call site. It stayed invisible while
// nothing ever cancelled a translation; sending them speculatively made
// aborting one routine, and it surfaced on a device as a crash in the middle
// of a turn.

describe('defaultFetcher cancellation on a runtime without DOMException', () => {
  const originalFetch = globals.fetch;
  const originalXhr = globals.XMLHttpRequest;
  const originalResponse = globals.Response;
  const originalDOMException = globals.DOMException;

  afterEach(() => {
    globals.fetch = originalFetch;
    globals.XMLHttpRequest = originalXhr;
    globals.Response = originalResponse;
    globals.DOMException = originalDOMException;
    jest.resetModules();
  });

  it('aborts cleanly and reports cancellation, with no DOMException in reach', async () => {
    // The runtime the app actually ships on: XHR transport, no DOMException.
    class BodylessResponse {}
    globals.Response = BodylessResponse;
    delete globals.DOMException;

    let aborted = false;
    class PendingXhr {
      onreadystatechange: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 0;
      status = 0;
      responseText = '';
      open(): void {}
      setRequestHeader(): void {}
      send(): void { /* never completes — only the abort ends this */ }
      abort(): void { aborted = true; }
    }
    globals.XMLHttpRequest = PendingXhr;

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MistralTranslator: Fresh } = require('../MistralTranslator');
    const t = new Fresh();
    const controller = new AbortController();
    const errors: Error[] = [];

    const running = t.translateStream({
      apiKey: 'sk',
      sourceText: 'algo',
      sourceLang: 'es',
      targetLang: 'en',
      signal: controller.signal,
      onSentence: () => {},
      onDone: () => {},
      onError: (e: Error) => errors.push(e),
    });

    // This is the call that used to throw a ReferenceError at the call site.
    expect(() => controller.abort()).not.toThrow();
    await running;

    expect(aborted).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/cancelled/i);
  });
});
