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
// Hands-free (HF) mode:
//   A single Voxtral WS (sessionMode) stays open across multiple utterances.
//   Silero VAD fires speech_start / speech_end; on speech_end we call
//   flushUtterance() to get the transcript, route by detected language, and
//   dispatch through the existing Mistral → TTS pipeline.
//
//   HF state machine:
//     hf-idle → hf-capturing → hf-flushing → hf-routing → hf-speaking
//             ↑                                          |           |
//             └──────────────── hf-cooldown (250 ms) ───┘           │
//                               ← lang ∉ pair (discard) ────────────┘
//
// Why dependency-injection?
//   The orchestrator owns the half-duplex lock and is the most error-prone
//   component, so it MUST be unit-testable without WebSockets, fetch, or
//   Android TTS. Every collaborator is an interface.

import { useConversationStore } from '../../store/conversationStore';
import type { PersonId } from '../../app/types';
import { log } from '../log/logStore';

/** Tiny non-cryptographic ID generator. */
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
    options: { apiKey: string; model?: string; sessionMode?: boolean },
    callbacks: {
      onPartial: (text: string) => void;
      onFinal: (text: string, language?: string) => void;
      onError: (err: Error) => void;
    },
  ): Promise<void>;
  feedAudio(base64Pcm: string): void;
  end(timeoutMs?: number): Promise<void>;
  cancel(): void;
  // Session-mode only (optional — not available in PTT mocks):
  flushUtterance?(timeoutMs?: number): Promise<{ text: string; language?: string }>;
  endSession?(): Promise<void>;
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

export interface VadLike {
  initialize(): Promise<void>;
  feedFrame(pcmInt16: Int16Array): void;
  subscribe(onSpeechStart: () => void, onSpeechEnd: () => void): () => void;
  setActive(active: boolean): void;
  destroy(): void;
}

// ── State machine ────────────────────────────────────────────────────────────

export type OrchestratorState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'translating'
  | 'speaking';

export type HfState =
  | 'hf-idle'
  | 'hf-capturing'
  | 'hf-flushing'
  | 'hf-routing'
  | 'hf-speaking'
  | 'hf-cooldown';

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
  readonly vad?: VadLike;
  readonly conversationStore?: typeof useConversationStore;
}

const DEFAULT_STT_MODEL = 'voxtral-mini-transcribe-realtime-2602';
/** PCM samples per VAD frame (512 @ 16 kHz = 32 ms). */
const VAD_FRAME_SAMPLES = 512;
/** Cooldown after TTS finishes before re-enabling VAD (same as PTT hangover). */
const HF_COOLDOWN_MS = 250;
/** Hard cap on accumulated VAD samples (1 s @ 16 kHz). Prevents heap growth
 *  if the inferencer wedges and stops draining. */
const MAX_VAD_BUFFER_SAMPLES = 16_000;

export class ConversationOrchestrator {
  // PTT state
  private state: OrchestratorState = 'idle';
  private activeTurnId: string | null = null;
  private currentArgs: BeginTurnArgs | null = null;
  private config: OrchestratorConfig | null = null;
  private translatedAccumulator = '';
  private ttsChunkPromises: Promise<void>[] = [];
  private translationAbort: AbortController | null = null;
  private turnCompletionPromise: Promise<void> | null = null;
  private resolveTurnCompletion: (() => void) | null = null;

  // HF state
  private hfEnabled = false;
  private hfPaused = false;
  private hfState: HfState = 'hf-idle';
  private hfVadUnsub: (() => void) | null = null;
  private hfPairA: string | null = null;  // language code for person_a
  private hfPairB: string | null = null;  // language code for person_b
  private vadBuffer: Int16Array = new Int16Array(0);
  private hfFirstAudioLogged = false;

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Read-only PTT state for UI debugging. */
  getState(): OrchestratorState {
    return this.state;
  }

  /** Read-only HF state for UI debugging. */
  getHfState(): HfState {
    return this.hfState;
  }

  /** Whether hands-free mode is currently active. */
  isHandsFreeActive(): boolean {
    return this.hfEnabled;
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

  /** Begin a PTT turn. Returns a Promise that resolves when the FULL turn
   *  (STT + translation + TTS) completes. Idempotent if already in a turn. */
  async beginTurn(args: BeginTurnArgs): Promise<void> {
    if (this.hfEnabled) {
      log.warn('[orch] beginTurn ignored — hands-free mode active');
      return;
    }
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

    this.deps.tts.prewarm(args.targetLang);

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
      if ((this.state as OrchestratorState) === 'transcribing' && this.activeTurnId === id) {
        log.info('[orch] handshake aborted by quick release — turn cancelled');
        const store = (this.deps.conversationStore ?? useConversationStore).getState();
        store.endTurn(id, { sourceText: '', translatedText: '', stage: 'done' });
        this.completeTurn(id);
        return;
      }
      log.error('[orch] Voxtral handshake rejected', e instanceof Error ? e : new Error(String(e)));
      void this.deps.audioCapture.stopStreaming().catch(() => {});
      this.failTurn(id, `Voxtral handshake failed: ${stringifyError(e)}`);
      return;
    }

    return this.turnCompletionPromise;
  }

  /** End the user's speaking phase (PTT release). */
  async endTurn(): Promise<void> {
    if (this.state !== 'recording') return;
    this.state = 'transcribing';
    const id = this.activeTurnId;
    if (id) {
      const store = (this.deps.conversationStore ?? useConversationStore).getState();
      store.updateTurn(id, { stage: 'transcribing' });
    }

    try {
      await this.deps.audioCapture.stopStreaming();
    } catch (e) {
      console.warn('[Orchestrator] stopStreaming failed:', e);
    }
    try {
      await this.deps.voxtral.end();
    } catch (e) {
      if (id) this.failTurn(id, `Voxtral end failed: ${stringifyError(e)}`);
    }
  }

  /** Abort the current PTT turn. */
  async cancelTurn(): Promise<void> {
    if (this.state === 'idle') return;
    const id = this.activeTurnId;
    try { this.translationAbort?.abort(); } catch { /* noop */ }
    try { await this.deps.audioCapture.stopStreaming().catch(() => {}); } catch { /* noop */ }
    try { this.deps.voxtral.cancel(); } catch { /* noop */ }
    try { this.deps.tts.stop(); } catch { /* noop */ }
    if (id) this.failTurn(id, 'Turn cancelled');
  }

  // ── Hands-Free API ────────────────────────────────────────────────────────

  /**
   * Activate hands-free mode:
   *   1. Initialize VAD (loads the ONNX model on first call).
   *   2. Start audio capture with dual-path routing (→ Voxtral, → VAD).
   *   3. Open a persistent Voxtral session (sessionMode=true).
   *   4. Subscribe to VAD events to drive the HF state machine.
   */
  async enableHandsFree(pairA: string, pairB: string): Promise<void> {
    if (this.hfEnabled) return;
    if (this.state !== 'idle') throw new Error('Cannot enable hands-free during an active PTT turn');
    if (!this.config?.apiKey) throw new Error('Orchestrator not configured (missing API key)');
    if (!this.deps.vad) throw new Error('No VAD service configured');

    const cfg = this.config;
    log.info(`[orch/hf] enabling — pair=${pairA}↔${pairB}`);

    this.hfPairA = pairA;
    this.hfPairB = pairB;
    this.hfEnabled = true;
    this.hfState = 'hf-idle';
    this.vadBuffer = new Int16Array(0);
    this.hfFirstAudioLogged = false;

    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.setMode('hf');

    // 1. Init VAD (no-op on subsequent calls).
    await this.deps.vad.initialize();

    // 2. Start audio capture with dual routing. Stop first to guarantee a clean
    //    state — a failed PTT turn may have left streaming=true (failTurn path).
    try { await this.deps.audioCapture.stopStreaming(); } catch { /* noop */ }
    this.deps.audioCapture.startStreaming((base64Pcm) => {
      this.deps.voxtral.feedAudio(base64Pcm);
      this.feedAudioToVad(base64Pcm);
    });

    // 3. Open persistent Voxtral session.
    await this.deps.voxtral.start(
      {
        apiKey: cfg.apiKey,
        model: cfg.sttModel ?? DEFAULT_STT_MODEL,
        sessionMode: true,
      },
      {
        onPartial: (text) => this.handleHfPartial(text),
        onFinal: () => { /* resolved via flushUtterance — this is informational only */ },
        onError: (err) => this.handleHfError(err),
      },
    );

    // 4. Subscribe to VAD events.
    this.hfVadUnsub = this.deps.vad.subscribe(
      () => this.handleHfSpeechStart(),
      () => void this.handleHfSpeechEnd(),
    );

    // Always re-arm VAD on enable — disableHandsFree leaves it inactive.
    this.deps.vad.setActive(true);

    log.info('[orch/hf] enabled — listening');
  }

  /**
   * Deactivate hands-free mode. Safe to call from any HF sub-state.
   * Cleans up VAD subscription, Voxtral session, and audio capture.
   *
   * Ordering: clear UI flags FIRST so the toggle and discs snap back
   * instantly, then tear down resources. If audioCapture.stopStreaming
   * stalls on Android (it has happened in production), the UI is still
   * coherent.
   */
  async disableHandsFree(): Promise<void> {
    if (!this.hfEnabled) return;
    log.info('[orch/hf] disabling');

    this.hfPaused = false;
    this.hfEnabled = false;
    this.hfState = 'hf-idle';

    // 1. Clear UI state synchronously — UI is coherent before any await.
    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.setMode('ptt');
    store.setHfActiveSpeaker(null);
    store.setHfUnroutedSpeaker(null);

    // 2. Stop VAD subscription.
    this.hfVadUnsub?.();
    this.hfVadUnsub = null;
    this.deps.vad?.setActive(false);

    // 3. Stop audio capture.
    try { await this.deps.audioCapture.stopStreaming(); } catch { /* noop */ }

    // 4. Close Voxtral session.
    try {
      if (this.deps.voxtral.endSession) {
        await this.deps.voxtral.endSession();
      } else {
        this.deps.voxtral.cancel();
      }
    } catch (e) {
      log.error('[orch/hf] endSession failed', e instanceof Error ? e : new Error(String(e)));
    }

    // 5. Stop any TTS in flight.
    try { this.deps.tts.stop(); } catch { /* noop */ }

    this.hfPairA = null;
    this.hfPairB = null;
    this.vadBuffer = new Int16Array(0);

    log.info('[orch/hf] disabled');
  }

  /**
   * Pause hands-free without tearing down the session — used when the device
   * loses connectivity. Stops the mic and disarms VAD; keeps `hfEnabled=true`
   * so the UI still reflects HF mode (with a "paused — offline" microcopy).
   * Safe to call when already paused or when HF is not active.
   */
  async pauseHandsFree(): Promise<void> {
    if (!this.hfEnabled || this.hfPaused) return;
    log.info('[orch/hf] pausing — network offline');
    this.hfPaused = true;
    this.hfState = 'hf-idle';
    this.vadBuffer = new Int16Array(0);
    this.deps.vad?.setActive(false);
    try { await this.deps.audioCapture.stopStreaming(); } catch { /* noop */ }
  }

  /**
   * Resume hands-free after a pause — restarts audio capture with the same
   * dual routing and re-arms VAD. Safe to call when not paused.
   */
  async resumeHandsFree(): Promise<void> {
    if (!this.hfEnabled || !this.hfPaused) return;
    log.info('[orch/hf] resuming — network online');
    try {
      this.deps.audioCapture.startStreaming((base64Pcm) => {
        this.deps.voxtral.feedAudio(base64Pcm);
        this.feedAudioToVad(base64Pcm);
      });
    } catch (e) {
      log.error('[orch/hf] resume audio capture failed', e instanceof Error ? e : new Error(String(e)));
      // Leave paused so UI can offer a manual disable.
      return;
    }
    this.hfPaused = false;
    this.deps.vad?.setActive(true);
  }

  /** Whether hands-free is currently paused (e.g. due to offline). */
  isHandsFreePaused(): boolean {
    return this.hfPaused;
  }

  // ── HF internal state machine ─────────────────────────────────────────────

  private handleHfSpeechStart(): void {
    if (!this.hfEnabled || this.hfPaused || this.hfState !== 'hf-idle') return;
    log.info('[orch/hf] speech_start → capturing');
    this.hfState = 'hf-capturing';
  }

  private async handleHfSpeechEnd(): Promise<void> {
    if (!this.hfEnabled || this.hfPaused || this.hfState !== 'hf-capturing') return;
    if (!this.deps.voxtral.flushUtterance) return;

    const vadEndAt = Date.now();
    log.info('[orch/hf] speech_end → flushing');
    this.hfState = 'hf-flushing';

    let result: { text: string; language?: string };
    const flushSentAt = Date.now();
    try {
      result = await this.deps.voxtral.flushUtterance(3_000);
    } catch (e) {
      log.error('[orch/hf] flushUtterance failed', e instanceof Error ? e : new Error(String(e)));
      if (this.hfEnabled) {
        this.hfState = 'hf-idle';
        await this.attemptHfReconnect();
      }
      return;
    }
    const flushedAt = Date.now();

    if (!this.hfEnabled) return;

    const { text, language } = result;
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      this.hfState = 'hf-idle';
      return;
    }

    // Route by detected language.
    const routing = this.routeUtterance(language ?? null, trimmed);
    const pairA = this.hfPairA;
    const pairB = this.hfPairB;
    if (!routing) {
      // Mismatched/discarded — emit compact telemetry if we have pair context.
      if (pairA && pairB) {
        log.info(
          `[hf_turn] ${JSON.stringify({
            kind: 'hf_turn',
            routedLanguage: language ?? null,
            configuredPair: [pairA, pairB],
            routingResult: 'mismatched',
            utteranceWordCount: trimmed.split(/\s+/).filter(Boolean).length,
          })}`,
        );
      }
      this.hfState = 'hf-idle';
      return;
    }

    const { speakerId, sourceLang, targetLang, kind: routingKind } = routing;
    this.hfState = 'hf-routing';

    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.setHfActiveSpeaker(speakerId);

    await this.dispatchHfTurn(speakerId, sourceLang, targetLang, trimmed, {
      vadEndAt,
      flushSentAt,
      flushedAt,
      routedLanguage: language ?? null,
      configuredPair: [pairA ?? '', pairB ?? ''],
      routingResult: routingKind,
    });

    if (this.hfEnabled) {
      store.setHfActiveSpeaker(null);
      this.hfState = 'hf-cooldown';
      await new Promise<void>((r) => setTimeout(r, HF_COOLDOWN_MS));
      if (this.hfEnabled && !this.hfPaused) {
        this.hfState = 'hf-idle';
        this.deps.vad?.setActive(true);
      } else if (this.hfEnabled) {
        this.hfState = 'hf-idle';
      }
    }
  }

  private routeUtterance(
    detectedLang: string | null,
    text: string,
  ): {
    speakerId: PersonId;
    sourceLang: string;
    targetLang: string;
    kind: 'matched' | 'fallback';
  } | null {
    const pairA = this.hfPairA;
    const pairB = this.hfPairB;
    if (!pairA || !pairB) return null;

    const store = (this.deps.conversationStore ?? useConversationStore).getState();

    if (detectedLang) {
      // Compare BCP-47 primary subtags so "es-MX" matches "es" symmetrically
      // and a regional pair like (es, es-MX) doesn't always route to A.
      const dl = primarySubtag(detectedLang);
      const a  = primarySubtag(pairA);
      const b  = primarySubtag(pairB);

      if (a !== b) {
        if (dl === a) {
          return { speakerId: 'person_a', sourceLang: pairA, targetLang: pairB, kind: 'matched' };
        }
        if (dl === b) {
          return { speakerId: 'person_b', sourceLang: pairB, targetLang: pairA, kind: 'matched' };
        }
      } else {
        // Same primary subtag both sides — language alone can't disambiguate.
        // Fall through to alternation.
      }

      if (a !== b) {
        // Language not in pair — discard with visual feedback on the side
        // whose turn it likely was (alternate from last routed).
        log.info(`[orch/hf] unrouted utterance lang=${detectedLang} text="${text.slice(0, 30)}"`);
        const lastDone = [...store.turns].reverse().find(t => t.stage === 'done');
        const flashSide: PersonId = lastDone?.speakerId === 'person_a' ? 'person_b' : 'person_a';
        store.setHfUnroutedSpeaker(flashSide);
        setTimeout(() => {
          if (this.hfEnabled) store.setHfUnroutedSpeaker(null);
        }, 600);
        return null;
      }
    }

    // No language tag (or ambiguous same-subtag pair) — alternate from last
    // routed turn. First turn defaults to person_a.
    const lastDone = [...store.turns].reverse().find(t => t.stage === 'done');
    if (lastDone?.speakerId === 'person_a') {
      return { speakerId: 'person_b', sourceLang: pairB, targetLang: pairA, kind: 'fallback' };
    }
    return { speakerId: 'person_a', sourceLang: pairA, targetLang: pairB, kind: 'fallback' };
  }

  private async dispatchHfTurn(
    speakerId: PersonId,
    sourceLang: string,
    targetLang: string,
    sourceText: string,
    telemetry: {
      vadEndAt: number;
      flushSentAt: number;
      flushedAt: number;
      routedLanguage: string | null;
      configuredPair: [string, string];
      routingResult: 'matched' | 'fallback';
    },
  ): Promise<void> {
    const cfg = this.config;
    if (!cfg) return;

    const id = turnId();
    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.startTurn({
      id,
      speakerId,
      sourceLang,
      targetLang,
      sourceText,
      translatedText: '',
      stage: 'translating',
      startedAt: Date.now(),
    });

    this.hfState = 'hf-speaking';
    this.deps.tts.prewarm(targetLang);
    this.deps.vad?.setActive(false);

    const abort = new AbortController();
    let translatedAcc = '';
    const ttsPromises: Promise<void>[] = [];
    let firstTokenAt: number | null = null;
    let firstTtsStartAt: number | null = null;

    await this.deps.translator.translateStream({
      signal: abort.signal,
      apiKey: cfg.apiKey,
      sourceText,
      sourceLang,
      targetLang,
      model: cfg.translationModel,
      onFirstToken: () => {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        this.deps.tts.prewarm(targetLang);
      },
      onSentence: (sentence) => {
        if (!this.hfEnabled) { abort.abort(); return; }
        if (firstTtsStartAt === null) firstTtsStartAt = Date.now();
        translatedAcc = (translatedAcc + ' ' + sentence).trim();
        store.updateTurn(id, { translatedText: translatedAcc, stage: 'speaking' });
        ttsPromises.push(
          this.deps.tts.speakChunk(sentence, targetLang).catch((e) => {
            console.warn('[orch/hf] TTS chunk error:', e);
          }),
        );
      },
      onDone: (fullText) => {
        store.updateTurn(id, { translatedText: fullText.trim() });
      },
      onError: (err) => {
        log.error('[orch/hf] translation error', err);
        store.endTurn(id, { stage: 'error', errorMessage: err.message });
      },
    });

    await Promise.all(ttsPromises);
    const endAt = Date.now();

    if (store.turns.find(t => t.id === id)?.stage !== 'error') {
      store.endTurn(id, { stage: 'done' });
    }

    // Phase 4 — structured HF turn telemetry (§11). Single emit per turn.
    const finalAt = telemetry.flushedAt;
    const payload = {
      kind: 'hf_turn' as const,
      vadEndToFlush: telemetry.flushSentAt - telemetry.vadEndAt,
      flushToFinal: finalAt - telemetry.flushSentAt,
      finalToFirstToken: firstTokenAt !== null ? firstTokenAt - finalAt : -1,
      firstTokenToFirstTtsStart:
        firstTokenAt !== null && firstTtsStartAt !== null
          ? firstTtsStartAt - firstTokenAt
          : -1,
      totalTurnDuration: endAt - telemetry.vadEndAt,
      routedLanguage: telemetry.routedLanguage,
      configuredPair: telemetry.configuredPair,
      routingResult: telemetry.routingResult,
      utteranceWordCount: sourceText.split(/\s+/).filter(Boolean).length,
    };
    log.info(`[hf_turn] ${JSON.stringify(payload)}`);
  }

  private handleHfPartial(_text: string): void {
    // No-op for now: HF partials arrive during 'hf-capturing', but we don't
    // create the store turn until flushUtterance resolves and language has
    // been routed. Writing partials to the previous (already-done) turn
    // would flicker its sourceText. If we want live partials in HF, we need
    // a separate transient store field rather than reusing activeTurnId.
  }

  private handleHfError(err: Error): void {
    log.error('[orch/hf] Voxtral error', err);
    if (!this.hfEnabled) return;
    void this.attemptHfReconnect();
  }

  private async attemptHfReconnect(): Promise<void> {
    const cfg = this.config;
    if (!cfg || !this.hfEnabled) return;

    // Pause VAD + drain buffer so stale frames don't trigger speech_start
    // against a half-open or freshly-reconnected session.
    this.deps.vad?.setActive(false);
    this.vadBuffer = new Int16Array(0);
    this.hfState = 'hf-idle';

    log.info('[orch/hf] reconnecting in 500 ms');
    await new Promise<void>((r) => setTimeout(r, 500));
    if (!this.hfEnabled) return;

    try {
      await this.deps.voxtral.start(
        { apiKey: cfg.apiKey, model: cfg.sttModel ?? DEFAULT_STT_MODEL, sessionMode: true },
        {
          onPartial: (text) => this.handleHfPartial(text),
          onFinal: () => {},
          onError: (err) => {
            log.error('[orch/hf] reconnect failed, disabling HF', err);
            void this.disableHandsFree();
          },
        },
      );
      // Re-arm VAD only after the new session is open.
      this.deps.vad?.setActive(true);
      log.info('[orch/hf] reconnected');
    } catch (e) {
      log.error('[orch/hf] reconnect attempt failed', e instanceof Error ? e : new Error(String(e)));
      void this.disableHandsFree();
    }
  }

  // ── VAD audio routing ─────────────────────────────────────────────────────

  private feedAudioToVad(base64Pcm: string): void {
    if (!this.deps.vad || !this.hfEnabled || this.hfPaused) return;

    if (!this.hfFirstAudioLogged) {
      this.hfFirstAudioLogged = true;
      log.info('[orch/hf] audio→vad: first chunk received');
    }

    // Decode base64 → bytes → Int16 PCM. Round byteLength down to the
    // nearest even count so a malformed/truncated chunk doesn't throw
    // RangeError when constructing the Int16Array.
    const binaryStr = atob(base64Pcm);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const safeLen = bytes.byteLength & ~1;
    if (safeLen === 0) return;
    const incoming = new Int16Array(bytes.buffer, 0, safeLen / 2);

    // Append to frame buffer and drain 512-sample frames. Cap the buffer
    // at MAX_VAD_BUFFER samples so a wedged inferencer can't OOM the heap.
    const merged = new Int16Array(this.vadBuffer.length + incoming.length);
    merged.set(this.vadBuffer);
    merged.set(incoming, this.vadBuffer.length);
    this.vadBuffer =
      merged.length > MAX_VAD_BUFFER_SAMPLES
        ? merged.slice(merged.length - MAX_VAD_BUFFER_SAMPLES)
        : merged;

    while (this.vadBuffer.length >= VAD_FRAME_SAMPLES) {
      const frame = this.vadBuffer.slice(0, VAD_FRAME_SAMPLES);
      try {
        this.deps.vad.feedFrame(frame);
      } catch (e) {
        log.error('[orch/hf] VAD feedFrame threw', e instanceof Error ? e : new Error(String(e)));
        // Drain rest of buffer rather than spamming the same broken inferencer.
        this.vadBuffer = new Int16Array(0);
        return;
      }
      this.vadBuffer = this.vadBuffer.slice(VAD_FRAME_SAMPLES);
    }
  }

  // ── PTT internal handlers ─────────────────────────────────────────────────

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
      store.endTurn(turnId, { sourceText: '', translatedText: '', stage: 'done' });
      this.completeTurn(turnId);
      return;
    }
    store.updateTurn(turnId, { sourceText: trimmed, stage: 'translating' });
    this.state = 'translating';

    const abort = new AbortController();
    this.translationAbort = abort;

    let translationFailed = false;

    await this.deps.translator.translateStream({
      signal: abort.signal,
      apiKey: cfg.apiKey,
      sourceText: trimmed,
      sourceLang: args.sourceLang,
      targetLang: args.targetLang,
      model: cfg.translationModel,
      onFirstToken: () => {
        this.deps.tts.prewarm(args.targetLang);
      },
      onSentence: (sentence) => {
        if (turnId !== this.activeTurnId) return;
        if (this.state !== 'speaking') this.state = 'speaking';
        this.translatedAccumulator =
          (this.translatedAccumulator + ' ' + sentence).trim();
        store.updateTurn(turnId, {
          translatedText: this.translatedAccumulator,
          stage: 'speaking',
        });
        this.ttsChunkPromises.push(
          this.deps.tts
            .speakChunk(sentence, args.targetLang)
            .catch((err) => { console.warn('[Orchestrator] TTS chunk error:', err); }),
        );
      },
      onDone: (fullText) => {
        if (turnId !== this.activeTurnId) return;
        store.updateTurn(turnId, { translatedText: fullText.trim() });
      },
      onError: (err) => {
        translationFailed = true;
        this.failTurn(turnId, err.message);
      },
    });

    if (translationFailed) return;
    if (turnId !== this.activeTurnId) return;

    await Promise.all(this.ttsChunkPromises);
    if (turnId !== this.activeTurnId) return;

    await new Promise<void>((r) => setTimeout(r, 250));
    if (turnId !== this.activeTurnId) return;

    store.endTurn(turnId, { stage: 'done' });
    this.completeTurn(turnId);
  }

  private failTurn(turnId: string, message: string): void {
    if (turnId !== this.activeTurnId) return;
    const store = (this.deps.conversationStore ?? useConversationStore).getState();
    store.endTurn(turnId, { stage: 'error', errorMessage: message });
    try { this.translationAbort?.abort(); } catch { /* noop */ }
    try { this.deps.tts.stop(); } catch { /* noop */ }
    // Stop the mic so a subsequent enableHandsFree() can re-register the
    // dual-path callback. Without this, a Voxtral mid-turn error (onError path)
    // leaves streaming=true and the next startStreaming() is a no-op.
    void this.deps.audioCapture.stopStreaming().catch(() => {});
    this.completeTurn(turnId);
  }

  private completeTurn(turnId: string): void {
    if (turnId !== this.activeTurnId) return;
    this.state = 'idle';
    this.activeTurnId = null;
    this.currentArgs = null;
    this.translatedAccumulator = '';
    this.ttsChunkPromises = [];
    this.translationAbort = null;
    const resolve = this.resolveTurnCompletion;
    this.resolveTurnCompletion = null;
    this.turnCompletionPromise = null;
    resolve?.();
  }
}

function stringifyError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** BCP-47 primary subtag — "es-MX" → "es", "EN" → "en". */
function primarySubtag(lang: string): string {
  const idx = lang.indexOf('-');
  return (idx === -1 ? lang : lang.slice(0, idx)).toLowerCase();
}
