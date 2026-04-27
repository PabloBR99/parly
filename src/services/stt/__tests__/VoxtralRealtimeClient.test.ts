/**
 * VoxtralRealtimeClient tests — WebSocket fully mocked via factory injection.
 */

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
}));

import { VoxtralRealtimeClient, type WebSocketLike, type WebSocketFactory } from '../VoxtralRealtimeClient';

// ── Fake WebSocket ────────────────────────────────────────────────────────────

interface FakeWs extends WebSocketLike {
  sent: string[];
  fire(event: 'open' | 'message' | 'error' | 'close', payload?: unknown): void;
}

function createFakeWs(): { ws: FakeWs; factory: WebSocketFactory; capturedHeaders: Record<string, string> | null; capturedUrl: string | null } {
  let capturedHeaders: Record<string, string> | null = null;
  let capturedUrl: string | null = null;

  const ws: FakeWs = {
    readyState: 1,
    sent: [],
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data: string) { this.sent.push(data); },
    close() { /* noop — tests drive close via .fire('close') */ },
    fire(event, payload) {
      if (event === 'open') this.onopen?.({});
      else if (event === 'message') this.onmessage?.({ data: payload });
      else if (event === 'error') this.onerror?.(payload ?? {});
      else if (event === 'close') this.onclose?.({});
    },
  };

  const factory: WebSocketFactory = (url, headers) => {
    capturedUrl = url;
    capturedHeaders = headers;
    return ws;
  };

  return {
    ws,
    factory,
    get capturedHeaders() { return capturedHeaders; },
    get capturedUrl() { return capturedUrl; },
  };
}

/** Build a callbacks object that records every event. */
function recording() {
  const partials: string[] = [];
  const finals: Array<{ text: string; language?: string }> = [];
  const errors: Error[] = [];
  return {
    partials,
    finals,
    errors,
    callbacks: {
      onPartial: (t: string) => partials.push(t),
      onFinal: (t: string, lang?: string) => finals.push({ text: t, language: lang }),
      onError: (e: Error) => errors.push(e),
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('VoxtralRealtimeClient', () => {
  it('opens the WebSocket with Bearer auth and model query param', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk-test' }, rec.callbacks);
    // Simulate handshake
    fake.ws.fire('open');
    fake.ws.fire('message', JSON.stringify({ type: 'session.created', session: {} }));
    await startPromise;

    expect(fake.capturedUrl).toContain('wss://api.mistral.ai/v1/audio/transcriptions/realtime');
    expect(fake.capturedUrl).toContain('model=voxtral-mini-transcribe-realtime-2602');
    expect(fake.capturedHeaders).toEqual({ Authorization: 'Bearer sk-test' });
  });

  it('sends session.update with pcm_s16le @ 16kHz on open', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    fake.ws.fire('open');
    fake.ws.fire('message', JSON.stringify({ type: 'session.created', session: {} }));
    await startPromise;

    const sent = fake.ws.sent.map(s => JSON.parse(s));
    const sessionUpdate = sent.find(m => m.type === 'session.update');
    expect(sessionUpdate).toBeDefined();
    expect(sessionUpdate.session.audio_format).toEqual({
      encoding: 'pcm_s16le',
      sample_rate: 16000,
    });
  });

  it('queues audio fed before session.created and drains on ready', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    // Feed chunks before session.created
    svc.feedAudio('chunk1-b64');
    svc.feedAudio('chunk2-b64');

    // No audio appends sent yet
    expect(fake.ws.sent.filter(s => s.includes('input_audio.append'))).toHaveLength(0);

    fake.ws.fire('open');
    fake.ws.fire('message', JSON.stringify({ type: 'session.created', session: {} }));
    await startPromise;

    const appends = fake.ws.sent.map(s => JSON.parse(s)).filter(m => m.type === 'input_audio.append');
    expect(appends).toHaveLength(2);
    expect(appends[0].audio).toBe('chunk1-b64');
    expect(appends[1].audio).toBe('chunk2-b64');
  });

  it('accumulates text.delta events and fires onPartial with running total', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    fake.ws.fire('open');
    fake.ws.fire('message', JSON.stringify({ type: 'session.created', session: {} }));
    await startPromise;

    fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'hola' }));
    fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: ' mundo' }));

    expect(rec.partials).toEqual(['hola', 'hola mundo']);
  });

  it('fires onFinal on transcription.done with accumulated text when event omits it', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    fake.ws.fire('open');
    fake.ws.fire('message', JSON.stringify({ type: 'session.created', session: {} }));
    await startPromise;

    fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'hello' }));
    fake.ws.fire('message', JSON.stringify({ type: 'transcription.language', language: 'en' }));
    fake.ws.fire('message', JSON.stringify({ type: 'transcription.done' }));

    expect(rec.finals).toEqual([{ text: 'hello', language: 'en' }]);
  });

  it('prefers transcription.done.text over accumulated when provided', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    fake.ws.fire('open');
    fake.ws.fire('message', JSON.stringify({ type: 'session.created', session: {} }));
    await startPromise;

    fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'partial' }));
    fake.ws.fire('message', JSON.stringify({ type: 'transcription.done', text: 'cleaned final' }));

    expect(rec.finals[0].text).toBe('cleaned final');
  });

  it('rejects start() on handshake timeout', async () => {
    jest.useFakeTimers();
    try {
      const fake = createFakeWs();
      const svc = new VoxtralRealtimeClient(fake.factory);
      const rec = recording();

      const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
      jest.advanceTimersByTime(10_000);
      await expect(startPromise).rejects.toThrow(/handshake timeout/);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects start() on error event before session.created', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk-bad' }, rec.callbacks);
    fake.ws.fire('open');
    fake.ws.fire('message', JSON.stringify({
      type: 'error',
      error: { message: 'Invalid API key', code: 'unauthorized' },
    }));

    await expect(startPromise).rejects.toThrow(/Invalid API key/);
  });

  it('rejects start() if WebSocket closes before session.created', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    fake.ws.fire('open');
    fake.ws.fire('close');

    await expect(startPromise).rejects.toThrow(/closed before session/);
  });

  it('fires onError for runtime errors after session.created', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    fake.ws.fire('open');
    fake.ws.fire('message', JSON.stringify({ type: 'session.created', session: {} }));
    await startPromise;

    fake.ws.fire('message', JSON.stringify({
      type: 'error',
      error: { message: 'Server overload' },
    }));

    expect(rec.errors).toHaveLength(1);
    expect(rec.errors[0].message).toMatch(/Server overload/);
  });

  it('end() sends input_audio.flush + input_audio.end and waits for done', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    fake.ws.fire('open');
    fake.ws.fire('message', JSON.stringify({ type: 'session.created', session: {} }));
    await startPromise;

    const endPromise = svc.end(5000);
    // Verify flush + end were sent before done arrives
    const types = fake.ws.sent.map(s => JSON.parse(s).type);
    expect(types).toContain('input_audio.flush');
    expect(types).toContain('input_audio.end');

    fake.ws.fire('message', JSON.stringify({ type: 'transcription.done', text: 'ok' }));
    await endPromise;

    expect(rec.finals[0].text).toBe('ok');
  });

  it('end() during connecting rejects pending start() (fast-tap freeze fix)', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    // No 'open' or 'session.created' fired — still 'connecting'.
    expect(svc.currentState).toBe('connecting');

    await svc.end();

    await expect(startPromise).rejects.toThrow(/handshake aborted/);
    expect(svc.currentState).toBe('closed');
    expect(rec.finals).toHaveLength(0);
  });

  it('cancel() during connecting rejects pending start()', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    expect(svc.currentState).toBe('connecting');

    svc.cancel();

    await expect(startPromise).rejects.toThrow(/handshake cancelled/);
    expect(svc.currentState).toBe('closed');
  });

  it('cancel() closes without firing onFinal', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    fake.ws.fire('open');
    fake.ws.fire('message', JSON.stringify({ type: 'session.created', session: {} }));
    await startPromise;

    fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'uh' }));
    svc.cancel();

    expect(rec.finals).toHaveLength(0);
    expect(svc.currentState).toBe('closed');
  });

  it('ignores non-string frames and malformed JSON gracefully', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    fake.ws.fire('open');
    fake.ws.fire('message', JSON.stringify({ type: 'session.created', session: {} }));
    await startPromise;

    // Various bad frames — none should crash, none should emit partials
    fake.ws.fire('message', '{not json');
    fake.ws.fire('message', new ArrayBuffer(4));
    fake.ws.fire('message', JSON.stringify({ no_type_field: true }));

    expect(rec.partials).toHaveLength(0);
    expect(rec.errors).toHaveLength(0);
    expect(svc.currentState).toBe('streaming');
  });
});
