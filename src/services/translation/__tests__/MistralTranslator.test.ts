jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
}));

import {
  MistralTranslator,
  parseSseEvent,
  flushSentences,
} from '../MistralTranslator';

// ── parseSseEvent ────────────────────────────────────────────────────────────

describe('parseSseEvent', () => {
  it('extracts delta.content from a normal chunk', () => {
    const event = 'data: {"choices":[{"delta":{"content":"Hola"}}]}';
    expect(parseSseEvent(event)).toBe('Hola');
  });

  it('returns null for [DONE] terminator', () => {
    expect(parseSseEvent('data: [DONE]')).toBeNull();
  });

  it('returns empty string for delta without content (role-only first chunk)', () => {
    const event = 'data: {"choices":[{"delta":{"role":"assistant"}}]}';
    expect(parseSseEvent(event)).toBe('');
  });

  it('returns null for unparseable JSON', () => {
    expect(parseSseEvent('data: {not json')).toBeNull();
  });

  it('returns null for non-data lines (comments etc.)', () => {
    expect(parseSseEvent(': keepalive')).toBeNull();
  });

  it('handles multi-line data prefixes (joins payloads)', () => {
    const event = 'data: {"choices":\ndata: [{"delta":{"content":"x"}}]}';
    expect(parseSseEvent(event)).toBe('x');
  });

  it('strips Windows \\r line endings', () => {
    const event = 'data: {"choices":[{"delta":{"content":"y"}}]}\r';
    expect(parseSseEvent(event)).toBe('y');
  });
});

// ── flushSentences ───────────────────────────────────────────────────────────

describe('flushSentences', () => {
  it('keeps short buffers (no boundary) entirely in remainder', () => {
    const out: string[] = [];
    const remaining = flushSentences('Hello world', s => out.push(s));
    expect(out).toEqual([]);
    expect(remaining).toBe('Hello world');
  });

  it('emits a long sentence when followed by space', () => {
    const out: string[] = [];
    const remaining = flushSentences(
      'This is a fairly long first sentence that exceeds the limit. And more.',
      s => out.push(s),
    );
    expect(out).toEqual([
      'This is a fairly long first sentence that exceeds the limit.',
    ]);
    expect(remaining).toBe('And more.');
  });

  it('does NOT split on abbreviations like "Mr."', () => {
    const out: string[] = [];
    flushSentences('Mr. Smith arrived at the embassy yesterday morning. ', s => out.push(s));
    // First boundary after "Mr." would yield a 3-char piece — skipped.
    // Second boundary is the real one — emits the whole thing.
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Mr. Smith');
    expect(out[0].endsWith('morning.')).toBe(true);
  });

  it('emits two sentences when both meet length and boundary requirements', () => {
    const out: string[] = [];
    const remaining = flushSentences(
      'The first long enough sentence is here. The second long enough one follows. tail',
      s => out.push(s),
    );
    expect(out).toHaveLength(2);
    expect(remaining).toBe('tail');
  });

  it('treats newlines as boundaries', () => {
    const out: string[] = [];
    flushSentences(
      'A reasonably sized first chunk\nA second one of similar length\n',
      s => out.push(s),
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it('handles CJK fullwidth period 。', () => {
    const out: string[] = [];
    flushSentences(
      '这是一句相当长的中文句子作为第一条用于测试。下一句。',
      s => out.push(s),
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it('handles Arabic ؟', () => {
    const out: string[] = [];
    const remaining = flushSentences(
      'هذا نص عربي طويل بما يكفي للاختبار؟ والمزيد بعد ذلك.',
      s => out.push(s),
    );
    expect(out.length).toBeGreaterThan(0);
    expect(remaining.length).toBeLessThan(50);
  });
});

// ── translateStream (with mock fetcher) ──────────────────────────────────────

interface MockFetcher {
  postStream: jest.Mock;
}

function mockFetcherOk(chunks: string[]): MockFetcher {
  return {
    postStream: jest.fn(async ({ onChunk }: { onChunk: (s: string) => void }) => {
      for (const c of chunks) onChunk(c);
      return { ok: true, status: 200 };
    }),
  };
}

function mockFetcherError(status: number, body = 'oops'): MockFetcher {
  return {
    postStream: jest.fn(async () => ({ ok: false, status, errorBody: body })),
  };
}

const sseChunk = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

const sseDone = 'data: [DONE]\n\n';

describe('MistralTranslator.translateStream', () => {
  it('streams sentences as they cross the boundary', async () => {
    const fetcher = mockFetcherOk([
      sseChunk('This is a long enough first sentence for emission.'),
      sseChunk(' '), // trigger the boundary check
      sseChunk('And the second sentence is similarly substantial.'),
      sseChunk(' tail'),
      sseDone,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = new MistralTranslator(fetcher as any);
    const sentences: string[] = [];
    let fullText = '';
    let firstToken = false;
    await t.translateStream({
      apiKey: 'sk',
      sourceText: 'algo',
      sourceLang: 'es',
      targetLang: 'en',
      onSentence: s => sentences.push(s),
      onDone: t => { fullText = t; },
      onError: () => {},
      onFirstToken: () => { firstToken = true; },
    });
    expect(firstToken).toBe(true);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(fullText).toContain('first sentence');
    expect(fullText).toContain('second sentence');
    expect(fullText.endsWith('tail')).toBe(true);
  });

  it('fires onDelta with cumulative text on every content delta', async () => {
    const fetcher = mockFetcherOk([
      sseChunk('Hola'),
      sseChunk(' mundo'),
      sseDone,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = new MistralTranslator(fetcher as any);
    const deltas: string[] = [];
    await t.translateStream({
      apiKey: 'sk',
      sourceText: 'x',
      sourceLang: 'es',
      targetLang: 'en',
      onDelta: full => deltas.push(full),
      onSentence: () => {},
      onDone: () => {},
      onError: () => {},
    });
    // Progressive display: text is available WELL before a sentence boundary.
    expect(deltas).toEqual(['Hola', 'Hola mundo']);
  });

  it('flushes the trailing buffer on stream end (no terminator)', async () => {
    const fetcher = mockFetcherOk([
      sseChunk('Yes.'),  // shorter than MIN_CHUNK_LEN — held in buffer
      sseDone,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = new MistralTranslator(fetcher as any);
    const sentences: string[] = [];
    await t.translateStream({
      apiKey: 'sk',
      sourceText: 'sí',
      sourceLang: 'es',
      targetLang: 'en',
      onSentence: s => sentences.push(s),
      onDone: () => {},
      onError: () => {},
    });
    expect(sentences).toEqual(['Yes.']);
  });

  it('surfaces 401 with a clear hint', async () => {
    const fetcher = mockFetcherError(401, 'invalid_api_key');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = new MistralTranslator(fetcher as any);
    const errors: Error[] = [];
    await t.translateStream({
      apiKey: 'sk-bad',
      sourceText: 'x',
      sourceLang: 'es',
      targetLang: 'en',
      onSentence: () => {},
      onDone: () => {},
      onError: e => errors.push(e),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('401');
    expect(errors[0].message.toLowerCase()).toContain('authentication');
  });

  it('sends correct headers and body to the fetcher', async () => {
    const fetcher = mockFetcherOk([sseDone]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = new MistralTranslator(fetcher as any);
    await t.translateStream({
      apiKey: 'sk-key',
      sourceText: 'hola',
      sourceLang: 'es',
      targetLang: 'en',
      model: 'mistral-large-latest',
      onSentence: () => {},
      onDone: () => {},
      onError: () => {},
    });
    expect(fetcher.postStream).toHaveBeenCalledTimes(1);
    const call = fetcher.postStream.mock.calls[0][0];
    expect(call.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(call.headers.Authorization).toBe('Bearer sk-key');
    expect(call.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(call.body);
    expect(body.model).toBe('mistral-large-latest');
    expect(body.stream).toBe(true);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('Spanish');
    expect(body.messages[0].content).toContain('English');
    expect(body.messages[1].content).toBe('hola');
  });

  it('does not call onDone when an error occurs', async () => {
    const fetcher = mockFetcherError(500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = new MistralTranslator(fetcher as any);
    let doneCalled = false;
    let errorCalled = false;
    await t.translateStream({
      apiKey: 'sk',
      sourceText: 'x',
      sourceLang: 'es',
      targetLang: 'en',
      onSentence: () => {},
      onDone: () => { doneCalled = true; },
      onError: () => { errorCalled = true; },
    });
    expect(errorCalled).toBe(true);
    expect(doneCalled).toBe(false);
  });

  it('handles split-mid-event chunk boundaries', async () => {
    // A real network might split a single SSE event across reads.
    const full = sseChunk('A reasonably sized translated chunk for testing.') + sseDone;
    const split1 = full.slice(0, 30);
    const split2 = full.slice(30);
    const fetcher = mockFetcherOk([split1, split2]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = new MistralTranslator(fetcher as any);
    const sentences: string[] = [];
    await t.translateStream({
      apiKey: 'sk',
      sourceText: 'x',
      sourceLang: 'es',
      targetLang: 'en',
      onSentence: s => sentences.push(s),
      onDone: () => {},
      onError: () => {},
    });
    expect(sentences.length).toBe(1);
    expect(sentences[0]).toContain('reasonably sized');
  });
});
