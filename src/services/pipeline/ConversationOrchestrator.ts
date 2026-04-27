// ConversationOrchestrator — owns the per-turn state machine for Parly v4.
//
// One turn ≡ one half-duplex push-to-talk:
//
//   user holds mic ─┬─► capture starts ──► Voxtral WS streams audio ──► partials update UI
//                   │
//   user releases ──┴─► capture stops ──► Voxtral final ──► Mistral translation SSE
//                                                                  │
//                                                                  ▼ (per sentence)
//                                                     react-native-tts speakChunk (queues)
//                                                                  │
//                                                                  ▼ (Promise.all)
//                                                              turn marked done
//
// Why a hard sequential state machine?
//   In a diplomatic demo the worst failure isn't a slow turn — it's a
//   confused turn (mic still hot during TTS, two turns interleaved, lock
//   leak that prevents the next press from working). Strict states with
//   guarded transitions make every code path provably terminate, and turn
//   the lock release into a single bottleneck we can audit.
//
// Why we DON'T persistently keep the Voxtral WS open between turns?
//   Idle WebSockets are subject to opaque server-side timeouts (we've seen
//   30-90s in the wild) and to network-change drops on mobile. The first
//   handshake post-app-start is the only one where TLS is cold; later WS
//   connects to api.mistral.ai re-use the cached TLS session and complete
//   in ~50-150 ms. Net: simpler reliability for a tiny latency cost.
//
// Why dependency-injection?
//   The orchestrator owns the half-duplex lock and is the most error-prone
//   component, so it MUST be unit-testable without WebSockets, fetch, or
//   Android TTS. Every collaborator is an interface.

import { useConversationStore } from '../../store/conversationStore';
import type { PersonId } from '../../app/types';
import { log } from '../log/logStore';

/** Tiny non-cryptographic ID generator. We avoid nanoid here because its ESM
 *  shipping form trips up Jest's default transform; we don't need crypto
 *  randomness for in-memory turn IDs. */
function turnId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Collaborator interfaces ──────────────────────────────────────────────────

export interface AudioCapture {
  requestPermission(): Promise<boolean>;
  startStreaming(onData: (base64Pcm: string) => void): void;
  stopStreaming(): Promise<void>;
}

export interface VoxtralLike {
  start(
    options: { apiKey: string; model?: string },
    callbacks: {
      onPartial: (text: string) => void;
      onFinal: (text: string, language?: string) => void;
      onError: (err: Error) => void;
    },
  ): Promise<void>;
  feedAudio(base64Pcm: string): void;
  end(timeoutMs?: number): Promise<void>;
  cancel(): void;
}

export interface TranslatorLike {
  prewarm(args: { apiKey: string; model?: string }): Promise<void>;
  translateStream(args: {
    apiKey: string;
    sourceText: string;
    sourceLang: string;
    targetLang: string;
    model?: string;
    signal?: AbortSignal;
    onFirstToken?: () => void;
    onSentence: (sentence: string) => void;
    onDone: (fullText: string) => void;
    onError: (err: Error) => void;
  }): Promise<void>;
}

export interface TTSLike {
  init(): Promise<void>;
  prewarm(language: string): void;
  speakChunk(text: string, language: string): Promise<void>;
  stop(): void;
}

// ── State machine ────────────────────────────────────────────────────────────

export type OrchestratorState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'translating'
  | 'speaking';

export interface BeginTurnArgs {
  readonly speakerId: PersonId;
  readonly sourceLang: string;
  readonly targetLang: string;
}

export interface OrchestratorConfig {
  readonly apiKey: string;
  readonly translationModel: string;
  readonly sttModel?: string;
}

interface OrchestratorDeps {
  readonly audioCapture: AudioCapture;
  readonly voxtral: VoxtralLike;
  readonly translator: TranslatorLike;
  readonly tts: TTSLike;
  readonly conversationStore?: typeof useConversationStore;
}

const DEFAULT_STT_MODEL = 'voxtral-mini-transcribe-realtime-2602';

export class ConversationOrchestrator {
  private state: OrchestratorState = 'idle';
  private activeTurnId: string | null = null;
  private currentArgs: BeginTurnArgs | null = null;
  private config: OrchestratorConfig | null = null;
  private translatedAccumulator = '';
  private ttsChunkPromises: Promise<void>[] = [];
  /** Resolved by handleTranscriptionFinal once the turn fully completes. */
  private turnCompletionPromise: Promise<void> | null = null;
  private resolveTurnCompletion: (() => void) | null = null;

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Read-only state for UI debugging. */
  getState(): OrchestratorState {
    return this.state;
  }

  /** Update the API key / model. Safe to call between turns. */
  configure(config: OrchestratorConfig): void {
    this.config = config;
  }

  /**
   * Best-effort warmup: TTS engine init + an HTTP/2 ping to api.mistral.ai
   * to open the TLS session. Saves ~150-300 ms on the first real translation.
   */
  async prewarm(): Promise<void> {
    await this.deps.tts.init();
    if (this.config?.apiKey) {
      await this.deps.translator.prewarm({
        apiKey: this.config.apiKey,
        model: this.config.translationModel,
      });
    }
  }

  /** Begin a turn. Returns a Promise that resolves when the FULL turn (STT
   *  + translation + TTS) completes. Idempotent if already in a turn. */
  async beginTurn(args: BeginTurnArgs): Promise<void> {
    if (this.state !== 'idle') {
      log.warn(`[orch] beginTurn ignored — state=${this.state}`);
      return;
    }
    if (!this.config?.apiKey) {
      log.error('[orch] beginTurn: no API key configured');
      throw new Error('Orchestrator not configured (missing API key)');
    }
    const cfg = this.config;
    log.info(`[orch] beginTurn speaker=${args.speakerId} ${args.sourceLang}→${args.targetLang}`);

    const id = turnId();
    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.startTurn({
      id,
      speakerId: args.speakerId,
      sourceLang: args.sourceLang,
      targetLang: args.targetLang,
      sourceText: '',
      translatedText: '',
      stage: 'recording',
      startedAt: Date.now(),
    });

    this.state = 'recording';
    this.activeTurnId = id;
    this.currentArgs = args;
    this.translatedAccumulator = '';
    this.ttsChunkPromises = [];
    this.turnCompletionPromise = new Promise<void>((resolve) => {
      this.resolveTurnCompletion = resolve;
    });

    // Speculative TTS warmup — load the target voice while the user speaks.
    this.deps.tts.prewarm(args.targetLang);

    // Open audio first so any chunks recorded during the WS handshake get
    // queued by the Voxtral client (it has an internal pre-session queue).
    try {
      this.deps.audioCapture.startStreaming((base64Pcm) => {
        this.deps.voxtral.feedAudio(base64Pcm);
      });
    } catch (e) {
      this.failTurn(id, `Audio capture failed: ${stringifyError(e)}`);
      return;
    }

    try {
      await this.deps.voxtral.start(
        { apiKey: cfg.apiKey, model: cfg.sttModel ?? DEFAULT_STT_MODEL },
        {
          onPartial: (text) => this.handlePartial(id, text),
          onFinal: (text) => this.handleFinal(id, text),
          onError: (err) => this.failTurn(id, err.message),
        },
      );
    } catch (e) {
      // start() rejection: handshake/auth failure
      log.error('[orch] Voxtral handshake rejected', e instanceof Error ? e : new Error(String(e)));
      void this.deps.audioCapture.stopStreaming().catch(() => {});
      this.failTurn(id, `Voxtral handshake failed: ${stringifyError(e)}`);
      return;
    }

    return this.turnCompletionPromise;
  }

  /**
   * End the user's speaking phase (PTT release). Triggers the rest of the
   * pipeline. Safe to call from any state — only acts if we're recording.
   */
  async endTurn(): Promise<void> {
    if (this.state !== 'recording') return;
    this.state = 'transcribing';
    const turnId = this.activeTurnId;
    if (turnId) {
      const store = (this.deps.conversationStore ?? useConversationStore).getState();
      store.updateTurn(turnId, { stage: 'transcribing' });
    }

    // Stop mic input first so the Voxtral final isn't influenced by trailing
    // self-noise. Then signal end-of-utterance to Voxtral.
    try {
      await this.deps.audioCapture.stopStreaming();
    } catch (e) {
      console.warn('[Orchestrator] stopStreaming failed:', e);
    }
    try {
      await this.deps.voxtral.end();
    } catch (e) {
      // Voxtral.end resolves on timeout too — only true exceptions reach here.
      if (turnId) this.failTurn(turnId, `Voxtral end failed: ${stringifyError(e)}`);
    }
  }

  /** Abort the current turn (e.g. user double-tap to cancel). */
  async cancelTurn(): Promise<void> {
    if (this.state === 'idle') return;
    const turnId = this.activeTurnId;
    try {
      await this.deps.audioCapture.stopStreaming().catch(() => {});
    } catch { /* noop */ }
    try { this.deps.voxtral.cancel(); } catch { /* noop */ }
    try { this.deps.tts.stop(); } catch { /* noop */ }
    if (turnId) this.failTurn(turnId, 'Turn cancelled');
  }

  // ── Internal handlers ───────────────────────────────────────────────────

  private handlePartial(turnId: string, partial: string): void {
    if (turnId !== this.activeTurnId) return;
    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.updateTurn(turnId, { sourceText: partial });
  }

  private handleFinal(turnId: string, finalText: string): void {
    if (turnId !== this.activeTurnId) return;
    void this.dispatchTranslation(turnId, finalText).catch((e) => {
      this.failTurn(turnId, `Pipeline error: ${stringifyError(e)}`);
    });
  }

  private async dispatchTranslation(turnId: string, finalText: string): Promise<void> {
    const args = this.currentArgs;
    const cfg = this.config;
    if (!args || !cfg) return;

    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    const trimmed = finalText.trim();
    if (trimmed.length === 0) {
      // Silence / empty transcription. End cleanly with empty translation.
      // CRITICAL: use endTurn (not updateTurn) — endTurn is what clears
      // activeTurnId in the store. Otherwise the next mic press's UI guard
      // sees a stale activeTurn and refuses to start.
      store.endTurn(turnId, {
        sourceText: '',
        translatedText: '',
        stage: 'done',
      });
      this.completeTurn(turnId);
      return;
    }
    store.updateTurn(turnId, { sourceText: trimmed, stage: 'translating' });
    this.state = 'translating';

    let translationFailed = false;

    await this.deps.translator.translateStream({
      apiKey: cfg.apiKey,
      sourceText: trimmed,
      sourceLang: args.sourceLang,
      targetLang: args.targetLang,
      model: cfg.translationModel,
      onFirstToken: () => {
        // Already prewarmed at beginTurn — but some devices benefit from a
        // second nudge once we know we'll definitely need TTS for this turn.
        this.deps.tts.prewarm(args.targetLang);
      },
      onSentence: (sentence) => {
        if (turnId !== this.activeTurnId) return;
        if (this.state !== 'speaking') {
          this.state = 'speaking';
        }
        this.translatedAccumulator =
          (this.translatedAccumulator + ' ' + sentence).trim();
        store.updateTurn(turnId, {
          translatedText: this.translatedAccumulator,
          stage: 'speaking',
        });
        // Queue TTS chunk; native engine handles the queue. Promise resolves
        // when the chunk's tts-finish fires — we collect them all and await
        // before completing the turn.
        this.ttsChunkPromises.push(
          this.deps.tts
            .speakChunk(sentence, args.targetLang)
            .catch((err) => {
              console.warn('[Orchestrator] TTS chunk error:', err);
            }),
        );
      },
      onDone: (fullText) => {
        if (turnId !== this.activeTurnId) return;
        // Lock the canonical translation for the message in case our
        // sentence-by-sentence accumulation differs (whitespace edges).
        store.updateTurn(turnId, { translatedText: fullText.trim() });
      },
      onError: (err) => {
        translationFailed = true;
        this.failTurn(turnId, err.message);
      },
    });

    if (translationFailed) return;
    if (turnId !== this.activeTurnId) return;

    // Wait for any queued TTS chunks to finish playing before releasing the
    // half-duplex lock. This is what prevents the device from picking up its
    // own translated speech as the next user turn.
    await Promise.all(this.ttsChunkPromises);
    if (turnId !== this.activeTurnId) return;

    // Tail silence — Android's audio sink can still be flushing the last
    // few PCM frames after `tts-finish` fires. A short hold prevents the
    // very tail from leaking into the next mic press.
    await new Promise<void>((r) => setTimeout(r, 250));
    if (turnId !== this.activeTurnId) return;

    // CRITICAL: endTurn (not updateTurn) so activeTurnId is cleared.
    // Otherwise the next mic press is blocked by the UI's "is a turn
    // already running?" guard.
    store.endTurn(turnId, { stage: 'done' });
    this.completeTurn(turnId);
  }

  private failTurn(turnId: string, message: string): void {
    if (turnId !== this.activeTurnId) return;
    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.endTurn(turnId, { stage: 'error', errorMessage: message });
    // Tear down anything in-flight.
    try { this.deps.tts.stop(); } catch { /* noop */ }
    this.completeTurn(turnId);
  }

  private completeTurn(turnId: string): void {
    if (turnId !== this.activeTurnId) return;
    this.state = 'idle';
    this.activeTurnId = null;
    this.currentArgs = null;
    this.translatedAccumulator = '';
    this.ttsChunkPromises = [];
    const resolve = this.resolveTurnCompletion;
    this.resolveTurnCompletion = null;
    this.turnCompletionPromise = null;
    resolve?.();
  }
}

function stringifyError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
