// OnlineStreamingSttService — Voxtral realtime transcription via WebSocket.
//
// Wire protocol reverse-engineered from mistralai/client-ts (MIT-licensed):
//   https://github.com/mistralai/client-ts/blob/main/src/extra/realtime/connection.ts
//
// URL:     wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=<model>
// Auth:    Authorization: Bearer <key>  (HTTP header on handshake)
// Format:  JSON text frames both directions. Audio is base64-encoded PCM.
//
// Server → client events (we handle these):
//   session.created            — must arrive before we send audio
//   transcription.text.delta   — incremental partial text (payload.text)
//   transcription.done         — final result (payload.text)
//   error                      — fatal; payload.error.{message,code}
//
// Client → server messages:
//   session.update             — optional audio_format override
//   input_audio.append         — base64 PCM chunk, any size
//   input_audio.flush          — force transcription of buffered audio
//   input_audio.end            — signal end-of-utterance
//
// Notes on React Native WebSocket:
//   - Third argument to `new WebSocket(url, protocols, options)` supports
//     { headers } on iOS and Android. Browser fetches would reject custom
//     headers, but RN's WebSocket is built on native libraries (OkHttp on
//     Android, NSURLSession on iOS) that honor them.

import type { PersonId } from '../../app/types';

const ENDPOINT = 'wss://api.mistral.ai/v1/audio/transcriptions/realtime';
const DEFAULT_MODEL = 'voxtral-mini-transcribe-realtime-2602';
const SAMPLE_RATE = 16_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;

export type StreamingState = 'idle' | 'connecting' | 'streaming' | 'ending' | 'closed';

export interface StreamingCallbacks {
  /** Fires with the current partial transcript as text-deltas arrive. */
  readonly onPartial: (partialText: string) => void;
  /** Fires once with the final transcript. Service is closed after. */
  readonly onFinal: (finalText: string, language?: string) => void;
  /** Fatal error — service is closed. */
  readonly onError: (error: Error) => void;
}

export interface StreamingStartOptions {
  readonly apiKey: string;
  readonly speakerId?: PersonId; // purely for UI routing in the partial store
  readonly model?: string;
}

/**
 * WebSocket-like surface we depend on. RN's global WebSocket and ws's WebSocket
 * are compatible with this shape — the third-arg options object (with headers)
 * is a constructor concern, not a runtime one, so it's not in this interface.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

/** Factory so tests can inject a fake WebSocket. Defaults to RN global WebSocket. */
export type WebSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => WebSocketLike;

const defaultWsFactory: WebSocketFactory = (url, headers) => {
  // RN's WebSocket accepts (url, protocols, options). Pass headers via options.
  // The `any` cast is necessary because TypeScript's lib.dom WebSocket doesn't
  // reflect RN's extended signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (WebSocket as any)(url, undefined, { headers });
};

export class OnlineStreamingSttService {
  private ws: WebSocketLike | null = null;
  private state: StreamingState = 'idle';
  private callbacks: StreamingCallbacks | null = null;
  private accumulatedText = '';
  private detectedLanguage: string | undefined;
  private sessionReady = false;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Chunks fed before session.created — drained once the session is ready. */
  private preSessionChunkQueue: string[] = [];
  private generation = 0;

  constructor(private readonly wsFactory: WebSocketFactory = defaultWsFactory) {}

  get currentState(): StreamingState {
    return this.state;
  }

  /**
   * Open the WebSocket and wait for session.created. Resolves when ready to
   * accept audio; rejects on handshake failure or timeout.
   */
  async start(options: StreamingStartOptions, callbacks: StreamingCallbacks): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'closed') {
      throw new Error(`Cannot start in state ${this.state}`);
    }

    this.generation++;
    const gen = this.generation;
    this.state = 'connecting';
    this.callbacks = callbacks;
    this.accumulatedText = '';
    this.detectedLanguage = undefined;
    this.sessionReady = false;
    this.preSessionChunkQueue = [];

    const model = options.model ?? DEFAULT_MODEL;
    const url = `${ENDPOINT}?model=${encodeURIComponent(model)}`;
    const headers = { Authorization: `Bearer ${options.apiKey}` };

    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(url, headers);
    } catch (e) {
      this.state = 'closed';
      throw new Error(`Failed to construct WebSocket: ${String(e)}`);
    }
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      const settle = (fn: () => void) => {
        if (this.handshakeTimer) {
          clearTimeout(this.handshakeTimer);
          this.handshakeTimer = null;
        }
        fn();
      };

      this.handshakeTimer = setTimeout(() => {
        if (gen !== this.generation) return;
        settle(() => {
          this.cleanup();
          reject(new Error('Voxtral WebSocket handshake timeout'));
        });
      }, HANDSHAKE_TIMEOUT_MS);

      ws.onopen = () => {
        if (gen !== this.generation) return;
        // Some servers allow implicit audio_format from handshake; we send an
        // explicit session.update so our assumption is unambiguous.
        try {
          ws.send(JSON.stringify({
            type: 'session.update',
            session: {
              audio_format: { encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
            },
          }));
        } catch (e) {
          settle(() => {
            this.cleanup();
            reject(new Error(`Failed to send session.update: ${String(e)}`));
          });
        }
      };

      ws.onmessage = (ev) => {
        if (gen !== this.generation) return;
        const parsed = this.parseEvent(ev.data);
        if (!parsed) return;

        if (parsed.type === 'session.created' || parsed.type === 'session.updated') {
          if (!this.sessionReady) {
            this.sessionReady = true;
            this.state = 'streaming';
            // Drain any chunks queued during handshake.
            const queued = this.preSessionChunkQueue;
            this.preSessionChunkQueue = [];
            for (const chunk of queued) this.sendAudioChunk(chunk);
            settle(() => resolve());
          }
          return;
        }

        if (parsed.type === 'transcription.text.delta') {
          const delta = typeof parsed.text === 'string' ? parsed.text : '';
          if (delta) {
            this.accumulatedText += delta;
            this.callbacks?.onPartial(this.accumulatedText);
          }
          return;
        }

        if (parsed.type === 'transcription.language') {
          const lang = typeof parsed.language === 'string' ? parsed.language : undefined;
          if (lang) this.detectedLanguage = lang;
          return;
        }

        if (parsed.type === 'transcription.done') {
          const finalText = typeof parsed.text === 'string'
            ? parsed.text
            : this.accumulatedText;
          this.callbacks?.onFinal(finalText, this.detectedLanguage);
          this.cleanup();
          return;
        }

        if (parsed.type === 'error') {
          const errObj = parsed.error as { message?: unknown; code?: unknown } | undefined;
          const msg = typeof errObj?.message === 'string'
            ? errObj.message
            : `Voxtral error (code=${String(errObj?.code ?? 'unknown')})`;
          const err = new Error(msg);
          if (!this.sessionReady) {
            settle(() => { this.cleanup(); reject(err); });
          } else {
            this.callbacks?.onError(err);
            this.cleanup();
          }
        }
      };

      ws.onerror = (ev) => {
        if (gen !== this.generation) return;
        const err = new Error(`WebSocket error: ${String((ev as { message?: string })?.message ?? ev)}`);
        if (!this.sessionReady) {
          settle(() => { this.cleanup(); reject(err); });
        } else {
          this.callbacks?.onError(err);
          this.cleanup();
        }
      };

      ws.onclose = () => {
        if (gen !== this.generation) return;
        if (!this.sessionReady) {
          settle(() => { this.cleanup(); reject(new Error('WebSocket closed before session.created')); });
        } else if (this.state !== 'ending' && this.state !== 'closed') {
          this.callbacks?.onError(new Error('WebSocket closed unexpectedly'));
          this.cleanup();
        }
      };
    });
  }

  /**
   * Forward a base64 PCM chunk. Safe to call before session.created — chunks
   * get queued and drained on handshake completion.
   */
  feedAudio(base64Pcm: string): void {
    if (this.state === 'connecting' && !this.sessionReady) {
      this.preSessionChunkQueue.push(base64Pcm);
      return;
    }
    if (this.state !== 'streaming') return;
    this.sendAudioChunk(base64Pcm);
  }

  /**
   * Signal end-of-utterance. Resolves when transcription.done arrives (or on
   * timeout/error). The onFinal callback fires before this resolves.
   */
  async end(finalTimeoutMs = 5_000): Promise<void> {
    if (this.state !== 'streaming') {
      this.cleanup();
      return;
    }
    this.state = 'ending';
    const gen = this.generation;

    try {
      this.ws?.send(JSON.stringify({ type: 'input_audio.flush' }));
      this.ws?.send(JSON.stringify({ type: 'input_audio.end' }));
    } catch (e) {
      this.callbacks?.onError(new Error(`Failed to signal end: ${String(e)}`));
      this.cleanup();
      return;
    }

    // Wait up to finalTimeoutMs for transcription.done (cleanup() fires after).
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => {
        const s: StreamingState = this.state;
        if (gen !== this.generation || s === 'closed') return resolve();
        if (Date.now() - start >= finalTimeoutMs) {
          // Force-close: onFinal with whatever partial we accumulated, then cleanup.
          this.callbacks?.onFinal(this.accumulatedText, this.detectedLanguage);
          this.cleanup();
          return resolve();
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  /** Abort without waiting for final. No onFinal fired. */
  cancel(): void {
    if (this.state === 'idle' || this.state === 'closed') return;
    this.cleanup();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private sendAudioChunk(base64Pcm: string): void {
    try {
      this.ws?.send(JSON.stringify({ type: 'input_audio.append', audio: base64Pcm }));
    } catch (e) {
      this.callbacks?.onError(new Error(`Failed to send audio chunk: ${String(e)}`));
      this.cleanup();
    }
  }

  private parseEvent(data: unknown): Record<string, unknown> | null {
    if (typeof data !== 'string') return null;
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { type?: unknown }).type === 'string') {
        return parsed as Record<string, unknown>;
      }
    } catch { /* ignore — unparseable frames are dropped */ }
    return null;
  }

  private cleanup(): void {
    this.generation++;
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try { this.ws.close(1000, 'client-done'); } catch { /* already closed */ }
      this.ws = null;
    }
    this.state = 'closed';
    this.callbacks = null;
    this.preSessionChunkQueue = [];
  }
}
