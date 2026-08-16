/**
 * VoxtralRealtimeClient tests — WebSocket fully mocked via factory injection.
 */

import {
  VoxtralRealtimeClient,
  TARGET_STREAMING_DELAY_MS,
  STREAMING_DELAY_ACCURATE_MS,
  STREAMING_DELAY_FAST_MS,
  type SocketFrame,
  type WebSocketLike,
  type WebSocketFactory,
} from '../VoxtralRealtimeClient';

// ── Fake WebSocket ────────────────────────────────────────────────────────────

interface FakeWs extends WebSocketLike {
  sent: string[];
  /** `payload` is the frame body, and only 'message' carries one. */
  fire(event: 'open' | 'message' | 'error' | 'close', payload?: SocketFrame): void;
}

function createFakeWs() {
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
      else if (event === 'message') this.onmessage?.({ data: payload ?? '' });
      else if (event === 'error') this.onerror?.({});
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

// ── Helper to complete the handshake ─────────────────────────────────────────

async function handshake(fake: ReturnType<typeof createFakeWs>, svc: VoxtralRealtimeClient, rec: ReturnType<typeof recording>, opts?: Partial<Parameters<VoxtralRealtimeClient['start']>[0]>) {
  const startPromise = svc.start({ apiKey: 'sk-test', ...opts }, rec.callbacks);
  fake.ws.fire('open');
  fake.ws.fire('message', JSON.stringify({ type: 'session.created', session: {} }));
  await startPromise;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('VoxtralRealtimeClient', () => {
  it('opens the WebSocket with Bearer auth and model query param', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk-test' }, rec.callbacks);
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

  it('includes target_streaming_delay_ms in session.update when sessionMode=true', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    await handshake(fake, svc, rec, { sessionMode: true });

    const sent = fake.ws.sent.map(s => JSON.parse(s));
    const sessionUpdate = sent.find(m => m.type === 'session.update');
    expect(sessionUpdate?.session.target_streaming_delay_ms).toBe(TARGET_STREAMING_DELAY_MS);
  });

  // Push-to-talk used to leave the delay to the server default, which meant
  // the two modes transcribed under conditions that differed by an unknown
  // amount and neither was written down. Both are explicit now.
  it('includes target_streaming_delay_ms in PTT mode too', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    await handshake(fake, svc, rec);

    const sent = fake.ws.sent.map(s => JSON.parse(s));
    const sessionUpdate = sent.find(m => m.type === 'session.update');
    expect(sessionUpdate?.session.target_streaming_delay_ms).toBe(
      STREAMING_DELAY_ACCURATE_MS,
    );
  });

  it('defaults to the accurate delay and honours an explicit one', async () => {
    expect(TARGET_STREAMING_DELAY_MS).toBe(STREAMING_DELAY_ACCURATE_MS);

    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    await handshake(fake, svc, rec, {
      sessionMode: true,
      targetStreamingDelayMs: STREAMING_DELAY_FAST_MS,
    });

    const sent = fake.ws.sent.map(s => JSON.parse(s));
    const sessionUpdate = sent.find(m => m.type === 'session.update');
    expect(sessionUpdate?.session.target_streaming_delay_ms).toBe(
      STREAMING_DELAY_FAST_MS,
    );
  });

  it('queues audio fed before session.created and drains on ready', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    svc.feedAudio('chunk1-b64');
    svc.feedAudio('chunk2-b64');

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

    await handshake(fake, svc, rec);

    fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'hola' }));
    fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: ' mundo' }));

    expect(rec.partials).toEqual(['hola', 'hola mundo']);
  });

  it('fires onFinal on transcription.done with accumulated text when event omits it', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    await handshake(fake, svc, rec);

    fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'hello' }));
    fake.ws.fire('message', JSON.stringify({ type: 'transcription.language', language: 'en' }));
    fake.ws.fire('message', JSON.stringify({ type: 'transcription.done' }));

    expect(rec.finals).toEqual([{ text: 'hello', language: 'en' }]);
  });

  it('prefers transcription.done.text over accumulated when provided', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    await handshake(fake, svc, rec);

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

    await handshake(fake, svc, rec);

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

    await handshake(fake, svc, rec);

    const endPromise = svc.end(5000);
    const types = fake.ws.sent.map(s => JSON.parse(s).type);
    expect(types).toContain('input_audio.flush');
    expect(types).toContain('input_audio.end');

    fake.ws.fire('message', JSON.stringify({ type: 'transcription.done', text: 'ok' }));
    await endPromise;

    expect(rec.finals[0].text).toBe('ok');
  });

  it('end() during connecting keeps queued audio and flushes once the session opens (quick release)', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    expect(svc.currentState).toBe('connecting');
    // The whole short utterance ("sí") arrives before the handshake finishes.
    svc.feedAudio('quick-utterance-b64');
    const endPromise = svc.end();

    // Handshake completes AFTER the release — the audio must not be thrown away.
    fake.ws.fire('open');
    fake.ws.fire('message', JSON.stringify({ type: 'session.created', session: {} }));
    await startPromise;

    const types = fake.ws.sent.map(s => JSON.parse(s).type);
    expect(types).toContain('input_audio.append');
    expect(types).toContain('input_audio.flush');
    expect(types).toContain('input_audio.end');
    // Queue drains before the flush, so the server transcribes the utterance.
    expect(types.indexOf('input_audio.append')).toBeLessThan(types.indexOf('input_audio.flush'));

    fake.ws.fire('message', JSON.stringify({ type: 'transcription.done', text: 'sí' }));
    await endPromise;
    expect(rec.finals[0].text).toBe('sí');
  });

  it('end() during connecting resolves and start() rejects when the handshake fails', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    const startPromise = svc.start({ apiKey: 'sk' }, rec.callbacks);
    const endPromise = svc.end();

    fake.ws.fire('close');

    await expect(startPromise).rejects.toThrow(/closed before session/);
    await endPromise;
    expect(svc.currentState).toBe('closed');
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

    await handshake(fake, svc, rec);

    fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'uh' }));
    svc.cancel();

    expect(rec.finals).toHaveLength(0);
    expect(svc.currentState).toBe('closed');
  });

  it('ignores non-string frames and malformed JSON gracefully', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);
    const rec = recording();

    await handshake(fake, svc, rec);

    fake.ws.fire('message', '{not json');
    fake.ws.fire('message', new ArrayBuffer(4));
    fake.ws.fire('message', JSON.stringify({ no_type_field: true }));

    expect(rec.partials).toHaveLength(0);
    expect(rec.errors).toHaveLength(0);
    expect(svc.currentState).toBe('streaming');
  });

  // ── Session mode tests ──────────────────────────────────────────────────────

  describe('sessionMode', () => {
    it('stays open after transcription.done and resets accumulator', async () => {
      const fake = createFakeWs();
      const svc = new VoxtralRealtimeClient(fake.factory);
      const rec = recording();

      await handshake(fake, svc, rec, { sessionMode: true });

      // First utterance
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'hello' }));
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.done', text: 'hello' }));

      expect(rec.finals).toHaveLength(1);
      expect(svc.currentState).toBe('streaming'); // still open!

      // Second utterance — accumulator should have reset
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'world' }));
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.done', text: 'world' }));

      expect(rec.finals).toHaveLength(2);
      expect(rec.finals[1].text).toBe('world');
      expect(svc.currentState).toBe('streaming');
    });

    it('closeSegment() answers with the server final when asked to wait', async () => {
      const fake = createFakeWs();
      const svc = new VoxtralRealtimeClient(fake.factory);
      const rec = recording();

      await handshake(fake, svc, rec, { sessionMode: true });

      const closed = svc.closeSegment(3_000);
      // Verify flush was sent
      const types = fake.ws.sent.map(s => JSON.parse(s).type);
      expect(types).toContain('input_audio.flush');

      // Server responds
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.language', language: 'es' }));
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.done', text: 'hola mundo' }));

      const result = await closed.final;
      expect(result.text).toBe('hola mundo');
      expect(result.language).toBe('es');
      expect(svc.currentState).toBe('streaming');
    });

    it('a second close joins the outstanding one instead of opening another', async () => {
      const fake = createFakeWs();
      const svc = new VoxtralRealtimeClient(fake.factory);
      const rec = recording();

      await handshake(fake, svc, rec, { sessionMode: true });

      // The caller closes speculatively at a pause, then asks again for real
      // when the turn actually ends. The segment is already closed: a second
      // flush would only close an empty buffer and race the first answer.
      const speculative = svc.closeSegment(3_000);
      const forReal = svc.closeSegment(3_000);
      const flushes = () =>
        fake.ws.sent.map(s => JSON.parse(s).type).filter(t => t === 'input_audio.flush');
      expect(flushes()).toHaveLength(1);

      // One answer settles both callers.
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.done', text: 'de Madrid' }));
      expect((await speculative.final).text).toBe('de Madrid');
      expect((await forReal.final).text).toBe('de Madrid');

      // Once answered, the next ask is a genuinely new round trip.
      const next = svc.closeSegment(3_000);
      expect(flushes()).toHaveLength(2);
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.done', text: 'pero vivo aquí' }));
      expect((await next.final).text).toBe('pero vivo aquí');
    });

    it('three back-to-back utterances all resolve via closeSegment', async () => {
      const fake = createFakeWs();
      const svc = new VoxtralRealtimeClient(fake.factory);
      const rec = recording();

      await handshake(fake, svc, rec, { sessionMode: true });

      const texts = ['first', 'second', 'third'];
      for (const t of texts) {
        const closed = svc.closeSegment();
        fake.ws.fire('message', JSON.stringify({ type: 'transcription.done', text: t }));
        const result = await closed.final;
        expect(result.text).toBe(t);
        expect(svc.currentState).toBe('streaming');
      }

      expect(rec.finals).toHaveLength(3);
    });

    it('closeSegment().final rejects on timeout when nothing was ever transcribed', async () => {
      jest.useFakeTimers();
      try {
        const fake = createFakeWs();
        const svc = new VoxtralRealtimeClient(fake.factory);
        const rec = recording();

        await handshake(fake, svc, rec, { sessionMode: true });

        const closed = svc.closeSegment(3_000);
        jest.advanceTimersByTime(4_000);

        await expect(closed.final).rejects.toThrow(/timeout/);
      } finally {
        jest.useRealTimers();
      }
    });

    it('closeSegment().final salvages the segment on timeout instead of dropping the utterance', async () => {
      jest.useFakeTimers();
      try {
        const fake = createFakeWs();
        const svc = new VoxtralRealtimeClient(fake.factory);
        const rec = recording();

        await handshake(fake, svc, rec, { sessionMode: true });

        // A long utterance streamed in fine — only the final frame is late.
        fake.ws.fire('message', JSON.stringify({ type: 'transcription.language', language: 'es' }));
        fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'una parrafada larga ' }));
        fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'que no debe perderse' }));

        const closed = svc.closeSegment(3_000);
        jest.advanceTimersByTime(4_000);

        const result = await closed.final;
        expect(result.text).toBe('una parrafada larga que no debe perderse');
        expect(result.language).toBe('es');
        // The session survives, and the accumulator is empty, so a late
        // transcription.done can't re-deliver the same words.
        expect(svc.currentState).toBe('streaming');
        fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'siguiente' }));
        const next = svc.closeSegment(3_000);
        fake.ws.fire('message', JSON.stringify({ type: 'transcription.done', text: 'siguiente' }));
        await expect(next.final).resolves.toEqual({ text: 'siguiente', language: undefined });
      } finally {
        jest.useRealTimers();
      }
    });

    it('a tail that streams in after the close is salvaged with the head, not instead of it', async () => {
      jest.useFakeTimers();
      try {
        const fake = createFakeWs();
        const svc = new VoxtralRealtimeClient(fake.factory);
        const rec = recording();

        await handshake(fake, svc, rec, { sessionMode: true });
        fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'la primera mitad ' }));

        const closed = svc.closeSegment(3_000);
        expect(closed.textSoFar).toBe('la primera mitad ');
        // The server keeps catching up on audio it already had, then never
        // answers. Nobody can have started speaking while it owed us this.
        fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'y la segunda' }));
        jest.advanceTimersByTime(4_000);

        await expect(closed.final).resolves.toEqual({
          text: 'la primera mitad y la segunda',
          language: undefined,
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('closeSegment().final rejects if WS closes while pending', async () => {
      const fake = createFakeWs();
      const svc = new VoxtralRealtimeClient(fake.factory);
      const rec = recording();

      await handshake(fake, svc, rec, { sessionMode: true });

      const closed = svc.closeSegment(3_000);
      // Simulate unexpected WS close
      fake.ws.fire('close');

      await expect(closed.final).rejects.toThrow(/VoxtralRealtimeClient closed/);
    });

    it('endSession() closes the WS and transitions to closed', async () => {
      const fake = createFakeWs();
      const svc = new VoxtralRealtimeClient(fake.factory);
      const rec = recording();

      await handshake(fake, svc, rec, { sessionMode: true });

      await svc.endSession();
      expect(svc.currentState).toBe('closed');

      const types = fake.ws.sent.map(s => JSON.parse(s).type);
      expect(types).toContain('input_audio.end');
    });

    it('resetUtterance() drops text accumulated since the last segment', async () => {
      const fake = createFakeWs();
      const svc = new VoxtralRealtimeClient(fake.factory);
      const rec = recording();

      await handshake(fake, svc, rec, { sessionMode: true });

      // TTS echo leaks in while VAD is gated…
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'echo' }));
      // …the orchestrator scrubs it before re-arming…
      svc.resetUtterance();
      // …so the next real utterance starts clean.
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'real' }));

      expect(rec.partials).toEqual(['echo', 'real']);
    });

    it('closeSegment() throws if called outside sessionMode', async () => {
      const fake = createFakeWs();
      const svc = new VoxtralRealtimeClient(fake.factory);
      const rec = recording();

      await handshake(fake, svc, rec); // PTT mode (no sessionMode)

      expect(() => svc.closeSegment()).toThrow(/sessionMode/);
    });

    it('closeSegment() hands back the streamed text without waiting for anything', async () => {
      const fake = createFakeWs();
      const svc = new VoxtralRealtimeClient(fake.factory);
      const rec = recording();

      await handshake(fake, svc, rec, { sessionMode: true });
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.language', language: 'es' }));
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'Buenos ' }));
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'días.' }));

      const closed = svc.closeSegment();

      expect(closed.textSoFar).toBe('Buenos días.');
      expect(closed.language).toBe('es');
      // The server still has to close the segment — we simply need not wait.
      expect(fake.ws.sent.map(s => JSON.parse(s).type)).toContain('input_audio.flush');
      // And the connection stays open for whoever speaks next.
      expect(svc.currentState).toBe('streaming');
    });

    it('a late final for a closed segment never eats the next speaker', async () => {
      const fake = createFakeWs();
      const svc = new VoxtralRealtimeClient(fake.factory);
      const rec = recording();

      await handshake(fake, svc, rec, { sessionMode: true });
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'Buenos días.' }));
      svc.closeSegment();

      // The next speaker is already talking when the server's answer to the
      // closed segment finally lands.
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'Good ' }));
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.done', text: 'Buenos días.' }));
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'morning.' }));

      // Their words survived the late done intact.
      expect(rec.partials.at(-1)).toBe('Good morning.');
      expect(svc.closeSegment().textSoFar).toBe('Good morning.');
    });

    it('a segment the server ends on its own still clears the accumulator', async () => {
      const fake = createFakeWs();
      const svc = new VoxtralRealtimeClient(fake.factory);
      const rec = recording();

      await handshake(fake, svc, rec, { sessionMode: true });
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'Buenos días.' }));
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.done', text: 'Buenos días.' }));
      fake.ws.fire('message', JSON.stringify({ type: 'transcription.text.delta', text: 'Y tú?' }));

      expect(rec.partials.at(-1)).toBe('Y tú?');
    });
  });
});

// ── A key that cannot be a header ────────────────────────────────────────────

describe('VoxtralRealtimeClient — refusing a key that cannot be sent', () => {
  it('never opens the socket with a header the platform would raise on', async () => {
    const fake = createFakeWs();
    const svc = new VoxtralRealtimeClient(fake.factory);

    // What was actually in the key field on the device that reported this.
    const pastedLog = '2026-08-11 INFO [orch/hf] enabling — pair=es↔en\n2026-08-11 INFO more';

    await expect(
      svc.start({ apiKey: pastedLog }, recording().callbacks),
    ).rejects.toThrow(/api key/i);

    // The handshake header is built by the platform, and an invalid value is
    // raised from inside it — past the point where the throw around the
    // constructor would see it, and past the point where the process
    // survives. So the socket is never reached at all.
    expect(fake.capturedUrl).toBeNull();
    expect(fake.capturedHeaders).toBeNull();
  });
});
