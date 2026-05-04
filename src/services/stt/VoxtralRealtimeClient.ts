// VoxtralRealtimeClient — Voxtral realtime transcription via WebSocket.
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
//   transcription.language     — language detected (payload.language)
//   transcription.segment      — emitted but ignored today
//   error                      — fatal; payload.error.{message,code}
//
// Client → server messages:
//   session.update             — optional audio_format + delay config
//   input_audio.append         — base64 PCM chunk, any size
//   input_audio.flush          — force transcription of buffered audio
//   input_audio.end            — signal end-of-utterance
//
// Session mode (hands-free):
//   When sessionMode=true, a single WS survives multiple utterances.
//   After each transcription.done the connection stays open; callers use
//   flushUtterance() to request a transcript for the latest speech segment
//   and endSession() to close the connection gracefully.
//
// Notes on React Native WebSocket:
//   - Third argument to `new WebSocket(url, protocols, options)` supports
//     { headers } on iOS and Android. Browser fetches would reject custom
//     headers, but RN's WebSocket is built on native libraries (OkHttp on
//     Android, NSURLSession on iOS) that honor them.

import type { PersonId } from '../../app/types';
import { log } from '../log/logStore';

const ENDPOINT = 'wss://api.mistral.ai/v1/audio/transcriptions/realtime';
const DEFAULT_MODEL = 'voxtral-mini-transcribe-realtime-2602';
const SAMPLE_RATE = 16_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;
export const TARGET_STREAMING_DELAY_MS = 480; // sweet-spot from Voxtral docs

export type StreamingState = 'idle' | 'connecting' | 'streaming' | 'ending' | 'closed';

export interface StreamingCallbacks {
  /** Fires with the current partial transcript as text-deltas arrive. */
  readonly onPartial: (partialText: string) => void;
  /** Fires once with the final transcript. In PTT mode the service is closed
   *  after; in session mode the connection stays open. */
  readonly onFinal: (finalText: string, language?: string) => void;
  /** Fatal error — service is closed. */
  readonly onError: (error: Error) => void;
}

export interface StreamingStartOptions {
  readonly apiKey: string;
  readonly speakerId?: PersonId; // purely for UI routing in the partial store
  readonly model?: string;
  /** Keep the WS open across multiple utterances (hands-free mode). */
  readonly sessionMode?: boolean;
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

export class VoxtralRealtimeClient {
  private ws: WebSocketLike | null = null;
  private state: StreamingState = 'idle';
  private callbacks: StreamingCallbacks | null = null;
  private accumulatedText = '';
  private detectedLanguage: string | undefined;
  private sessionReady = false;
  private sessionMode = false;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Captured so end()/cancel() can reject a pending start() during the
   *  'connecting' phase. Without this, an early abort calls cleanup() and
   *  silently nulls the WS handlers, leaving start()'s Promise forever
   *  pending — which is exactly the "fast-tap freeze" the user reported. */
  private handshakeReject: ((err: Error) => void) | null = null;
  /** Chunks fed before session.created — drained once the session is ready. */
  private preSessionChunkQueue: string[] = [];
  private generation = 0;

  // Session-mode flush resolution (one pending flush at a time).
  private flushResolve: ((result: { text: string; language?: string }) => void) | null = null;
  private flushReject: ((err: Error) => void) | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.sessionMode = options.sessionMode ?? false;
    this.preSessionChunkQueue = [];

    const model = options.model ?? DEFAULT_MODEL;
    const url = `${ENDPOINT}?model=${encodeURIComponent(model)}`;
    const headers = { Authorization: `Bearer ${options.apiKey}` };

    log.info(`[voxtral] connecting model=${model} sessionMode=${this.sessionMode}`);

    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(url, headers);
    } catch (e) {
      log.error('[voxtral] WebSocket constructor threw', e instanceof Error ? e : new Error(String(e)));
      this.state = 'closed';
      throw new Error(`Failed to construct WebSocket: ${String(e)}`);
    }
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      this.handshakeReject = reject;
      const settle = (fn: () => void) => {
        if (this.handshakeTimer) {
          clearTimeout(this.handshakeTimer);
          this.handshakeTimer = null;
        }
        this.handshakeReject = null;
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
        log.info('[voxtral] onopen — sending session.update');
        // Voxtral's session schema only accepts audio_format (and optional
        // target_streaming_delay_ms). Extra fields are rejected with Pydantic
        // extra_forbidden, so we only include the delay in session mode where
        // the lower latency matters most.
        const session: Record<string, unknown> = {
          audio_format: { encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
        };
        if (this.sessionMode) {
          session.target_streaming_delay_ms = TARGET_STREAMING_DELAY_MS;
        }
        try {
          ws.send(JSON.stringify({ type: 'session.update', session }));
        } catch (e) {
          log.error('[voxtral] session.update send failed', e instanceof Error ? e : new Error(String(e)));
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

        if (parsed.type === 'transcription.segment') {
          // Emitted by Voxtral in streaming mode. Not used today.
          return;
        }

        if (parsed.type === 'transcription.done') {
          const finalText = typeof parsed.text === 'string'
            ? parsed.text
            : this.accumulatedText;
          this.callbacks?.onFinal(finalText, this.detectedLanguage);

          if (this.sessionMode) {
            // Resolve any pending flushUtterance().
            const resolve = this.flushResolve;
            const flushedLang = this.detectedLanguage;
            if (resolve) {
              this.clearFlushPending();
              resolve({ text: finalText, language: flushedLang });
            }
            // Reset accumulator for the next utterance — keep WS open.
            this.accumulatedText = '';
            this.detectedLanguage = undefined;
          } else {
            this.cleanup();
          }
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
        const detail = describeEvent(ev);
        log.error(`[voxtral] onerror ${detail}`);
        const err = new Error(`WebSocket error: ${detail}`);
        if (!this.sessionReady) {
          settle(() => { this.cleanup(); reject(err); });
        } else {
          this.callbacks?.onError(err);
          this.cleanup();
        }
      };

      ws.onclose = (ev) => {
        if (gen !== this.generation) return;
        const closeInfo = describeClose(ev);
        log.info(`[voxtral] onclose ${closeInfo}`);
        if (!this.sessionReady) {
          settle(() => {
            this.cleanup();
            reject(new Error(`WebSocket closed before session.created (${closeInfo})`));
          });
        } else if (this.state !== 'ending' && this.state !== 'closed') {
          this.callbacks?.onError(new Error(`WebSocket closed unexpectedly (${closeInfo})`));
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
   * Only valid in PTT mode (non-session). In session mode, use flushUtterance().
   */
  async end(finalTimeoutMs = 5_000): Promise<void> {
    if (this.state === 'connecting') {
      // User released before the WS finished handshaking. Reject the pending
      // start() so the caller's `await` unblocks instead of hanging forever.
      const reject = this.handshakeReject;
      this.handshakeReject = null;
      this.cleanup();
      reject?.(new Error('Voxtral handshake aborted'));
      return;
    }
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

  /**
   * Session-mode only: send input_audio.flush and resolve with the next
   * transcription.done. The WS stays open for the next utterance.
   * Rejects if transcription.done doesn't arrive within timeoutMs.
   */
  async flushUtterance(timeoutMs = 3_000): Promise<{ text: string; language?: string }> {
    if (this.state !== 'streaming') {
      throw new Error(`flushUtterance called in state ${this.state}`);
    }
    if (!this.sessionMode) {
      throw new Error('flushUtterance requires sessionMode=true');
    }
    if (this.flushResolve) {
      throw new Error('flushUtterance already in progress');
    }

    return new Promise<{ text: string; language?: string }>((resolve, reject) => {
      this.flushResolve = resolve;
      this.flushReject = reject;
      this.flushTimer = setTimeout(() => {
        this.clearFlushPending();
        reject(new Error(`flushUtterance timeout after ${timeoutMs} ms`));
      }, timeoutMs);

      try {
        this.ws?.send(JSON.stringify({ type: 'input_audio.flush' }));
      } catch (e) {
        this.clearFlushPending();
        reject(new Error(`Failed to send flush: ${String(e)}`));
      }
    });
  }

  /**
   * Session-mode only: send input_audio.end and close the WebSocket.
   * Use this instead of end() to terminate a session-mode connection.
   */
  async endSession(): Promise<void> {
    if (this.state === 'idle' || this.state === 'closed') return;
    this.state = 'ending';
    try {
      this.ws?.send(JSON.stringify({ type: 'input_audio.end' }));
    } catch { /* ignore — we're closing anyway */ }
    this.cleanup();
  }

  /** Abort without waiting for final. No onFinal fired. */
  cancel(): void {
    if (this.state === 'idle' || this.state === 'closed') return;
    if (this.state === 'connecting') {
      const reject = this.handshakeReject;
      this.handshakeReject = null;
      this.cleanup();
      reject?.(new Error('Voxtral handshake cancelled'));
      return;
    }
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

  private clearFlushPending(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushResolve = null;
    this.flushReject = null;
  }

  private cleanup(): void {
    this.generation++;
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    this.handshakeReject = null;
    // Reject any pending flushUtterance.
    const flushReject = this.flushReject;
    this.clearFlushPending();
    flushReject?.(new Error('VoxtralRealtimeClient closed'));

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
    this.sessionMode = false;
  }
}

// ── Event introspection ─────────────────────────────────────────────────────
//
// React Native's WebSocket onerror/onclose events are not standard DOM events;
// they're plain objects whose shape varies by platform and RN version. We
// extract whatever useful fields exist and fall back to JSON.stringify so the
// log buffer always shows something meaningful.

function describeEvent(ev: unknown): string {
  if (ev == null) return '(null event)';
  if (typeof ev !== 'object') return String(ev);
  const o = ev as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof o.message === 'string')                            parts.push(`message="${o.message}"`);
  if (typeof o.code === 'number' || typeof o.code === 'string') parts.push(`code=${o.code}`);
  if (typeof o.reason === 'string')                             parts.push(`reason="${o.reason}"`);
  const errInner = o.error;
  if (errInner && typeof errInner === 'object') {
    const ei = errInner as Record<string, unknown>;
    if (typeof ei.message === 'string') parts.push(`error.message="${ei.message}"`);
  } else if (typeof errInner === 'string') {
    parts.push(`error="${errInner}"`);
  }
  if (parts.length === 0) {
    try {
      return `raw=${JSON.stringify(ev)}`;
    } catch {
      return `raw=${Object.prototype.toString.call(ev)}`;
    }
  }
  return parts.join(' ');
}

function describeClose(ev: unknown): string {
  if (ev == null) return '(null close)';
  if (typeof ev !== 'object') return `value=${String(ev)}`;
  const o = ev as { code?: unknown; reason?: unknown; wasClean?: unknown };
  const code   = o.code   ?? 'unknown';
  const reason = typeof o.reason === 'string' ? o.reason : '';
  const clean  = o.wasClean === undefined ? '' : ` wasClean=${o.wasClean}`;
  return `code=${code} reason="${reason}"${clean}`;
}
