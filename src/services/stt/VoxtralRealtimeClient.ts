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
// Session mode (hands-free): one WS survives many utterances. closeSegment()
// is the only way to end a segment, and it answers twice — `textSoFar` now,
// `final` a round trip later — because choosing between them is a
// latency/punctuation trade-off that belongs to the caller. Deltas arriving
// between the flush and its answer belong to the segment being closed: the
// server closes it on receipt, so anything still arriving is it catching up.
//
// RN's WebSocket takes { headers } as its third constructor argument, unlike
// the browser's: it is built on OkHttp / NSURLSession, which honour them.

import { asText, isJsonObject, isNumber, isString, parseJson } from '../../app/json';
import { toError } from '../../app/errors';
import type { JsonObject, JsonValue } from '../../app/json';
import type { PersonId } from '../../app/types';
import { isSendableKey } from '../auth/validateApiKey';
import { log } from '../log/logStore';

const ENDPOINT = 'wss://api.mistral.ai/v1/audio/transcriptions/realtime';
const DEFAULT_MODEL = 'voxtral-mini-transcribe-realtime-2602';
const SAMPLE_RATE = 16_000;
// 4 s, not 8: on a degraded network nobody is still holding the disc at
// 8 seconds — fail fast into the speaker-side retry notice instead.
const HANDSHAKE_TIMEOUT_MS = 4_000;
// Right context: how much of the FOLLOWING audio Voxtral has in hand when it
// commits each word, and the parameter the whole accuracy/latency trade-off
// runs through. Mistral's figure is that 480 ms matches their offline batch
// model (within 1-2 WER points on English); below it the curve turns down, and
// not evenly — fast conversational speech is *reduced* speech, thinner in
// acoustic evidence per word, so it leans hardest on this context.
//
// 480 is the default; 320 sits behind a Settings choice for anyone who wants
// the 160 ms back. `scripts/voxtral-wer-bench.mjs` decides with numbers.
export const STREAMING_DELAY_ACCURATE_MS = 480;
export const STREAMING_DELAY_FAST_MS = 320;
export const TARGET_STREAMING_DELAY_MS = STREAMING_DELAY_ACCURATE_MS;

export type StreamingState = 'idle' | 'connecting' | 'streaming' | 'ending' | 'closed';

/** A server frame worth looking at, or null. Unreadable frames and binary ones
 *  are dropped here so the handler never sees them. */
function parseFrame(data: SocketFrame): JsonObject | null {
  if (typeof data !== 'string') return null;
  const frame = parseJson(data);
  return isJsonObject(frame) && isString(frame.type) ? frame : null;
}

function errorFrameMessage(error: JsonValue | undefined): string {
  if (isJsonObject(error)) {
    const message = asText(error.message);
    if (message !== undefined) return message;
    const code = error.code;
    if (isString(code) || isNumber(code)) return `Voxtral error (code=${code})`;
  }
  return 'Voxtral error (code=unknown)';
}

/** Both answers to "end this segment" — see closeSegment(). */
export interface SegmentClose {
  /** What the server has already streamed for this segment, available now. */
  readonly textSoFar: string;
  readonly language: string | undefined;
  /** The server's own transcript for the same segment, one round trip later. */
  readonly final: Promise<{ text: string; language?: string }>;
}

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
  /** Right context the server buffers before committing words. Defaults to
   *  STREAMING_DELAY_ACCURATE_MS — see that constant for what it costs. */
  readonly targetStreamingDelayMs?: number;
}

/** Voxtral speaks JSON text frames; a binary frame is not part of the protocol
 *  and gets dropped. */
export type SocketFrame = string | ArrayBuffer;

/** What RN hands a WebSocket handler — plain objects, not DOM events, whose
 *  fields vary by platform and RN version, hence all optional. */
export interface SocketEvent {
  readonly message?: JsonValue;
  readonly code?: JsonValue;
  readonly reason?: JsonValue;
  readonly wasClean?: JsonValue;
  readonly error?: JsonValue;
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
  onopen: ((ev: SocketEvent) => void) | null;
  onmessage: ((ev: { data: SocketFrame }) => void) | null;
  onerror: ((ev: SocketEvent) => void) | null;
  onclose: ((ev: SocketEvent) => void) | null;
}

/** Factory so tests can inject a fake WebSocket. Defaults to RN global WebSocket. */
export type WebSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => WebSocketLike;

const defaultWsFactory: WebSocketFactory = (url, headers) => {
  // SAFETY: RN's WebSocket takes a third options argument; lib.dom's
  // declaration predates it. The runtime object is RN's, so its signature is
  // the real one — see the header note on why headers work here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (WebSocket as any)(url, undefined, { headers }) as WebSocketLike;
};

export class VoxtralRealtimeClient {
  private ws: WebSocketLike | null = null;
  private state: StreamingState = 'idle';
  private callbacks: StreamingCallbacks | null = null;
  private accumulatedText = '';
  private detectedLanguage: string | undefined;
  private sessionReady = false;
  private sessionMode = false;
  private targetStreamingDelayMs = STREAMING_DELAY_ACCURATE_MS;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Captured so end()/cancel() can reject a pending start() during the
   *  'connecting' phase. Without this, an early abort calls cleanup() and
   *  silently nulls the WS handlers, leaving start()'s Promise forever
   *  pending — which is exactly the "fast-tap freeze" the user reported. */
  private handshakeReject: ((err: Error) => void) | null = null;
  /** Chunks fed before session.created — drained once the session is ready. */
  private preSessionChunkQueue: string[] = [];
  /** Set when end() is called during 'connecting': PTT was released before
   *  the handshake finished. Instead of aborting and throwing the queued
   *  audio away (which silently ate every short utterance — "sí", "ok"),
   *  the session.created handler drains the queue and immediately sends
   *  flush + end so the turn completes normally. */
  private flushOnReady = false;
  /** Resolvers waiting for this connection to finish (transcription.done or
   *  any terminal cleanup). Resolved from the event handlers — no polling. */
  private finalWaiters: Array<() => void> = [];
  private generation = 0;

  // Session-mode segment closing (one segment closing at a time).
  private closeResolve: ((result: { text: string; language?: string }) => void) | null = null;
  private closeReject: ((err: Error) => void) | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The outstanding close's answer, handed to any caller that closes while one
   *  is still in the air. The segment is already closed and one
   *  transcription.done answers everybody — see closeSegment(). */
  private closeInFlight: Promise<{ text: string; language?: string }> | null = null;

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
    this.targetStreamingDelayMs =
      options.targetStreamingDelayMs ?? STREAMING_DELAY_ACCURATE_MS;
    this.preSessionChunkQueue = [];
    this.flushOnReady = false;

    const model = options.model ?? DEFAULT_MODEL;
    const url = `${ENDPOINT}?model=${encodeURIComponent(model)}`;
    // Refused here rather than passed to the socket: a header value the
    // platform rejects is raised from inside its own networking layer, where
    // the throw below cannot see it and the process does not survive it.
    if (!isSendableKey(options.apiKey)) {
      this.state = 'closed';
      throw new Error('That API key cannot be used — check it in Settings.');
    }
    const headers = { Authorization: `Bearer ${options.apiKey.trim()}` };

    log.info(
      `[voxtral] connecting model=${model} sessionMode=${this.sessionMode} ` +
        `delay=${this.targetStreamingDelayMs}ms`,
    );

    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(url, headers);
    } catch (e) {
      log.error('[voxtral] WebSocket constructor threw', toError(e));
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

      // Before session.created a failure has nobody to report to but the
      // pending start(); after it, the caller is mid-turn and hears about it
      // through onError. Every path below fails the same way.
      const fail = (err: Error): void => {
        if (this.sessionReady) {
          this.callbacks?.onError(err);
          this.cleanup();
        } else {
          settle(() => { this.cleanup(); reject(err); });
        }
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
        // The schema accepts these two fields and nothing else — anything extra
        // comes back as a Pydantic extra_forbidden error. There is no language
        // hint and no vocabulary biasing on this socket (they exist only on the
        // HTTP endpoint, which wants a finished file), which is why names are
        // repaired downstream instead — see nameRepair. The delay is sent in
        // both modes, so PTT and hands-free transcribe under the same
        // conditions rather than PTT silently taking a server default.
        const session = {
          audio_format: { encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
          target_streaming_delay_ms: this.targetStreamingDelayMs,
        };
        try {
          ws.send(JSON.stringify({ type: 'session.update', session }));
        } catch (e) {
          log.error('[voxtral] session.update send failed', toError(e));
          settle(() => {
            this.cleanup();
            reject(new Error(`Failed to send session.update: ${String(e)}`));
          });
        }
      };

      ws.onmessage = (ev) => {
        if (gen !== this.generation) return;
        const frame = parseFrame(ev.data);
        if (!frame) return;

        if (frame.type === 'session.created' || frame.type === 'session.updated') {
          if (!this.sessionReady) {
            this.sessionReady = true;
            this.state = 'streaming';
            // Drain any chunks queued during handshake.
            const queued = this.preSessionChunkQueue;
            this.preSessionChunkQueue = [];
            for (const chunk of queued) this.sendAudioChunk(chunk);
            settle(() => resolve());
            // PTT was already released while we were connecting — the whole
            // utterance is the queue we just drained. Flush it now so the
            // quick-release turn transcribes instead of being discarded.
            if (this.flushOnReady) {
              this.flushOnReady = false;
              this.state = 'ending';
              this.signalEnd();
            }
          }
          return;
        }

        if (frame.type === 'transcription.text.delta') {
          const delta = asText(frame.text);
          if (delta) {
            this.accumulatedText += delta;
            this.callbacks?.onPartial(this.accumulatedText);
          }
          return;
        }

        if (frame.type === 'transcription.language') {
          const language = asText(frame.language);
          if (language) this.detectedLanguage = language;
          return;
        }

        if (frame.type === 'transcription.done') {
          const finalText = asText(frame.text) ?? this.accumulatedText;
          this.callbacks?.onFinal(finalText, this.detectedLanguage);

          if (this.sessionMode) {
            const resolve = this.closeResolve;
            if (resolve) {
              // The segment this answers was emptied when it was closed, and
              // the accumulator has belonged to whoever spoke next ever since.
              // Wiping it here is how a late answer eats their opening words.
              this.clearClosePending();
              resolve({ text: finalText, language: this.detectedLanguage });
            } else {
              // The server ended a segment on its own — nobody closed it, so
              // nobody has taken its text. Reset for the next one.
              this.accumulatedText = '';
              this.detectedLanguage = undefined;
            }
          } else {
            this.cleanup();
          }
          return;
        }

        if (frame.type === 'error') fail(new Error(errorFrameMessage(frame.error)));
      };

      ws.onerror = (ev) => {
        if (gen !== this.generation) return;
        const detail = describeEvent(ev);
        log.error(`[voxtral] onerror ${detail}`);
        fail(new Error(`WebSocket error: ${detail}`));
      };

      ws.onclose = (ev) => {
        if (gen !== this.generation) return;
        const closeInfo = describeClose(ev);
        log.info(`[voxtral] onclose ${closeInfo}`);
        // A close we asked for is not a failure — only an unexpected one is.
        if (!this.sessionReady) {
          fail(new Error(`WebSocket closed before session.created (${closeInfo})`));
        } else if (this.state !== 'ending' && this.state !== 'closed') {
          fail(new Error(`WebSocket closed unexpectedly (${closeInfo})`));
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
   * Only valid in PTT mode (non-session). In session mode, use closeSegment().
   */
  async end(finalTimeoutMs = 5_000): Promise<void> {
    if (this.state === 'connecting') {
      // User released before the WS finished handshaking. Don't abort — the
      // whole utterance is sitting in preSessionChunkQueue. Mark the session
      // to flush the instant it opens and wait for the final like any other
      // turn. If the handshake genuinely fails, cleanup() rejects start()
      // (via the handshake timer / onerror / onclose) and resolves us.
      this.flushOnReady = true;
      return this.waitForFinal(finalTimeoutMs + HANDSHAKE_TIMEOUT_MS);
    }
    if (this.state !== 'streaming') {
      this.cleanup();
      return;
    }
    this.state = 'ending';
    if (!this.signalEnd()) return;
    return this.waitForFinal(finalTimeoutMs);
  }

  /** Flush the buffered audio and declare the utterance over. False means the
   *  socket refused it, which is terminal — the caller is already cleaned up. */
  private signalEnd(): boolean {
    try {
      this.ws?.send(JSON.stringify({ type: 'input_audio.flush' }));
      this.ws?.send(JSON.stringify({ type: 'input_audio.end' }));
      return true;
    } catch (e) {
      this.callbacks?.onError(new Error(`Failed to signal end: ${String(e)}`));
      this.cleanup();
      return false;
    }
  }

  /** Resolve when this connection reaches a terminal event (transcription.done
   *  in PTT mode, or any cleanup). Event-driven — resolved from cleanup(), not
   *  polled. On timeout, emit whatever partial we accumulated and close. */
  private waitForFinal(timeoutMs: number): Promise<void> {
    const gen = this.generation;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (gen === this.generation && this.state !== 'closed') {
          // Still connecting? The pending start() must reject, or beginTurn
          // hangs forever (cleanup alone silently nulls the handlers).
          const rejectHandshake = this.handshakeReject;
          this.handshakeReject = null;
          if (!rejectHandshake) {
            this.callbacks?.onFinal(this.accumulatedText, this.detectedLanguage);
          }
          this.cleanup();
          rejectHandshake?.(new Error('Voxtral handshake timed out after release'));
        }
        resolve();
      }, timeoutMs);
      this.finalWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Session-mode only: end the current speech segment.
   *
   * Answers twice, because the caller is the one who knows which it needs:
   *
   *   textSoFar — what the server already streamed, available synchronously.
   *     Normally the whole utterance, since the silence the caller waited
   *     through is longer than the audio the server buffers.
   *   final — the server's own transcript, one round trip later. Same words,
   *     tidier punctuation, several hundred ms of dead air. Worth it when
   *     textSoFar is empty or still growing, a bad trade when it isn't.
   *
   * The flush goes out either way — the server has to close the segment so the
   * next speaker starts clean. Closing while one is outstanding JOINS it rather
   * than opening a second, since one transcription.done answers everybody, and
   * that is what lets a caller close early on a guess and ask again for real.
   *
   * `final` salvages the accumulated partial if the answer never comes: losing
   * a minute of speech to a slow final frame is worse than losing its last
   * comma. It rejects only if nothing accumulated, or the connection died.
   */
  closeSegment(timeoutMs = 3_000): SegmentClose {
    if (!this.sessionMode) {
      throw new Error('closeSegment requires sessionMode=true');
    }
    if (this.state !== 'streaming' && !this.closeInFlight) {
      throw new Error(`closeSegment called in state ${this.state}`);
    }
    // Take the segment's text as we close it. Everything the accumulator holds
    // from here on belongs to whoever speaks next — which is what makes a late
    // answer harmless, and what a ledger of outstanding commits used to fake.
    const textSoFar = this.accumulatedText;
    const language = this.detectedLanguage;
    if (this.closeInFlight) return { textSoFar, language, final: this.closeInFlight };
    this.accumulatedText = '';
    this.detectedLanguage = undefined;

    let sendFailed = false;
    const final = new Promise<{ text: string; language?: string }>((resolve, reject) => {
      // The server's answer is authoritative about the words. It may not
      // repeat the language it already reported for this segment, so the
      // reading taken at close time stands in.
      this.closeResolve = (r) => resolve({ text: r.text, language: r.language ?? language });
      this.closeReject = reject;
      this.closeTimer = setTimeout(() => {
        this.clearClosePending();
        // Whatever streamed after the close is this segment's tail, not the
        // next speaker: nobody can have started while the server owed us an
        // answer for the words before it.
        const salvaged = `${textSoFar}${this.accumulatedText}`.trim();
        if (salvaged.length > 0) {
          log.warn(`[voxtral] close timeout after ${timeoutMs} ms — salvaging ${salvaged.length}-char partial`);
          const salvagedLang = this.detectedLanguage ?? language;
          this.accumulatedText = '';
          this.detectedLanguage = undefined;
          resolve({ text: salvaged, language: salvagedLang });
          return;
        }
        reject(new Error(`closeSegment timeout after ${timeoutMs} ms`));
      }, timeoutMs);

      try {
        this.ws?.send(JSON.stringify({ type: 'input_audio.flush' }));
      } catch (e) {
        sendFailed = true;
        this.clearClosePending();
        reject(new Error(`Failed to send flush: ${String(e)}`));
      }
    });
    // Only publish a handle that something can still answer. The send above
    // runs inside the executor, so a synchronous failure has already cleared
    // the pending state and must not be re-published here.
    if (!sendFailed) this.closeInFlight = final;
    return { textSoFar, language, final };
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

  /**
   * Session-mode: drop any transcript accumulated since the last segment.
   * Used when re-arming VAD after TTS playback — anything captured in the
   * gap is the echo of the phone's own speaker, not the next speaker.
   */
  resetUtterance(): void {
    this.accumulatedText = '';
    this.detectedLanguage = undefined;
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

  private clearClosePending(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.closeResolve = null;
    this.closeReject = null;
    this.closeInFlight = null;
  }

  private cleanup(): void {
    this.generation++;
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    this.handshakeReject = null;
    this.flushOnReady = false;
    // Reject any pending closeSegment().
    const closeReject = this.closeReject;
    this.clearClosePending();
    closeReject?.(new Error('VoxtralRealtimeClient closed'));
    // Resolve anything awaiting end() — this connection is terminal.
    const waiters = this.finalWaiters;
    this.finalWaiters = [];
    for (const w of waiters) w();

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

function describeEvent(ev: SocketEvent): string {
  const parts: string[] = [];
  const message = asText(ev.message);
  if (message !== undefined) parts.push(`message="${message}"`);
  if (isString(ev.code) || isNumber(ev.code)) parts.push(`code=${ev.code}`);
  const reason = asText(ev.reason);
  if (reason !== undefined) parts.push(`reason="${reason}"`);
  if (isJsonObject(ev.error)) {
    const inner = asText(ev.error.message);
    if (inner !== undefined) parts.push(`error.message="${inner}"`);
  } else {
    const error = asText(ev.error);
    if (error !== undefined) parts.push(`error="${error}"`);
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

function describeClose(ev: SocketEvent): string {
  const code = isString(ev.code) || isNumber(ev.code) ? ev.code : 'unknown';
  const reason = asText(ev.reason) ?? '';
  const clean = ev.wasClean === undefined ? '' : ` wasClean=${String(ev.wasClean)}`;
  return `code=${code} reason="${reason}"${clean}`;
}
